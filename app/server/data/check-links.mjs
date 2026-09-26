#!/usr/bin/env node
/**
 * check-links.mjs —— 资源库链接真实性校验脚本
 *
 * 放在 app/server/data/ 下，与 resources.json 同级。
 * 零依赖，只用 Node 内置能力（>= 18 的全局 fetch / AbortSignal）。
 *
 * 判定规则（与资源库数据的 verified 字段约定一致）：
 *   200 / 301 / 302 / 403  -> 可达（reachable）
 *                            403 多为反爬/Cloudflare 拦截，note 标注「需浏览器访问」
 *   404 / 410 / 超时 / DNS 失败 / 连接失败 -> 失效（dead）
 *
 * 其它状态码（401/405/429/5xx 等）归为「存疑（warn）」，需要人工用浏览器确认一次。
 *
 * 用法：
 *   node check-links.mjs                       # 校验并打印表格（不写文件）
 *   node check-links.mjs --write               # 校验并把结果回填进 resources.json 的 verified
 *   node check-links.mjs --report out.json     # 额外导出一份原始报告
 *   node check-links.mjs --urls probe.txt      # 只探测文本里的候选 URL（每行一个，可带 "id | url | name"）
 *   node check-links.mjs --urls probe.txt --json
 *   node check-links.mjs --timeout 8000 --concurrency 6
 *
 * 退出码：0 = 全部可达；1 = 存在失效或存疑条目。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(HERE, 'resources.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36 DSH-Workstation-LinkChecker/1.0';

// 判定规则与任务约定一致：200/301/302/403 视为可达。
// 307/308 同为正常重定向（如 moises.ai → /zh），也计入可达，但 note 里会标注跳转目标。
const REACHABLE = new Set([200, 301, 302, 307, 308, 403]);
const DEAD = new Set([404, 410]);

// ---------------------------------------------------------------- CLI 解析

function parseArgs(argv) {
  const out = { write: false, json: false, report: null, urls: null, timeout: 8000, concurrency: 6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--json') out.json = true;
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--urls') out.urls = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || 8000;
    else if (a === '--concurrency') out.concurrency = Math.max(1, Number(argv[++i]) || 6);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log(
    [
      'check-links.mjs —— 资源库链接校验（零依赖）',
      '',
      '  node check-links.mjs [--write] [--report out.json] [--json]',
      '  node check-links.mjs --urls probe.txt [--json]',
      '',
      '  --write        把结果回填到 resources.json 的 verified 字段',
      '  --report FILE  导出完整报告 JSON',
      '  --urls FILE    只探测候选 URL 列表（每行: url，或 "标签 | url"，或 "标签 | url | 备注"）',
      '  --timeout MS   单次请求超时，默认 8000',
      '  --concurrency N 并发数，默认 6',
      '',
      '判定：200/301/302/403 = 可达；404/410/超时/DNS 失败 = 失效；其余 = 存疑。',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------- 探测

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${ms}ms`)), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

async function fetchOnce(url, method, timeout) {
  const t = withTimeout(timeout);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      signal: t.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
        'cache-control': 'no-cache',
      },
    });
    let body = '';
    if (method === 'GET') {
      try {
        body = (await res.text()).slice(0, 4000);
      } catch {
        body = '';
      }
    }
    return { status: res.status, location: res.headers.get('location') || '', body, err: null };
  } catch (e) {
    return { status: 0, location: '', body: '', err: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
  } finally {
    t.done();
  }
}

/**
 * HEAD 优先，失败/被拒时退回 GET。
 * 返回 { status, method, note, finalUrl, error }
 */
export async function probe(url, timeout = 8000, retries = 4) {
  let r = null;
  let method = 'HEAD';

  // 本机对海外站点（github.com 等）存在明显网络抖动：同一个 URL 可能第 1 次
  // UND_ERR_CONNECT_TIMEOUT、第 2 次就 200。因此连不通时退避重试多次，
  // 避免把「一时连不上」误判成「站点已死」而错误剔除有效条目。
  for (let attempt = 0; attempt <= retries; attempt++) {
    r = await fetchOnce(url, 'HEAD', timeout);
    method = 'HEAD';

    // 405/501/400/0/403 都值得再试一次 GET：不少站直接禁 HEAD。
    if (r.err || r.status === 0 || r.status === 405 || r.status === 501 || r.status === 400 || r.status === 403) {
      const g = await fetchOnce(url, 'GET', timeout);
      if (!g.err && g.status !== 0) {
        r = g;
        method = 'GET';
      } else if (r.err) {
        r = g; // HEAD 网络层失败，以 GET 的错误为准
        method = 'GET';
      }
    }

    // 拿到任何 HTTP 状态码即算探测成功，无需重试
    if (r.status > 0) break;
    if (attempt < retries) await new Promise((res) => setTimeout(res, 1200 * (attempt + 1)));
  }

  const note = classifyNote(r, method);
  return {
    url,
    status: r.status,
    method,
    location: r.location,
    note,
    error: r.err,
    title: extractTitle(r.body),
  };
}

function classifyNote(r, method) {
  if (r.err === 'timeout') return `超时（${method}）`;
  if (r.err) return `连接失败（${method}）`;
  const s = r.status;
  if (s === 403) return '需浏览器访问';
  if (s >= 300 && s < 400) return `重定向 → ${r.location || '未知'}`;
  if (s === 200) return '';
  if (s === 401) return '需登录';
  if (s === 429) return '限流，需重试';
  if (s >= 500) return '服务端错误';
  return `状态 ${s}`;
}

function extractTitle(html) {
  if (!html) return '';
  const m = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

export function verdictOf(status, error) {
  if (error) return 'dead';
  if (REACHABLE.has(status)) return 'ok';
  if (DEAD.has(status)) return 'dead';
  return 'warn';
}

// ---------------------------------------------------------------- 并发池

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------------------------------------------------------- 主流程

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function collectFromResources() {
  const raw = await readFile(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);
  const targets = [];
  for (const g of data.groups || []) {
    for (const it of g.items || []) {
      if (it.url) targets.push({ id: `${g.id}/${it.id}`, url: it.url, name: it.name || it.id });
    }
  }
  return { data, targets };
}

async function collectFromFile(file) {
  const raw = await readFile(file, 'utf8');
  const targets = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const parts = s.split('|').map((x) => x.trim());
    if (parts.length === 1) targets.push({ id: parts[0], url: parts[0], name: parts[0] });
    else if (parts[0].startsWith('http')) targets.push({ id: parts[0], url: parts[0], name: parts[1] || parts[0] });
    else targets.push({ id: parts[0], url: parts[1], name: parts[2] || parts[0] });
  }
  return { data: null, targets };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const { data, targets } = args.urls ? await collectFromFile(args.urls) : await collectFromResources();
  const date = today();

  console.error(`[check-links] 探测 ${targets.length} 条链接，并发 ${args.concurrency}，超时 ${args.timeout}ms …`);
  const results = await pool(targets, args.concurrency, async (t) => {
    const r = await probe(t.url, args.timeout);
    r.id = t.id;
    r.name = t.name;
    r.verdict = verdictOf(r.status, r.error);
    process.stderr.write(`  ${r.verdict === 'ok' ? 'OK ' : r.verdict === 'warn' ? '?? ' : 'XX '} ${r.status || r.error}  ${t.id}\n`);
    return r;
  });

  const ok = results.filter((r) => r.verdict === 'ok');
  const warn = results.filter((r) => r.verdict === 'warn');
  const dead = results.filter((r) => r.verdict === 'dead');

  // ---- 回填 verified
  if (args.write && data) {
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const g of data.groups || []) {
      for (const it of g.items || []) {
        const r = byId.get(`${g.id}/${it.id}`);
        if (!r) continue;
        it.verified = { status: r.status || 0, checkedAt: date, note: r.note || '' };
      }
    }
    data.updatedAt = date;
    await writeFile(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.error(`[check-links] 已回填 ${results.length} 条 verified → ${DATA_FILE}`);
  }

  const report = {
    checkedAt: date,
    total: results.length,
    ok: ok.length,
    warn: warn.length,
    dead: dead.length,
    passRate: results.length ? +(ok.length / results.length * 100).toFixed(1) : 0,
    targets: results,
  };

  if (args.report) {
    await writeFile(args.report, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.error(`[check-links] 报告 → ${args.report}`);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log(`校验日期 ${date} | 共 ${results.length} 条 | 可达 ${ok.length} | 存疑 ${warn.length} | 失效 ${dead.length} | 通过率 ${report.passRate}%`);
    if (dead.length) {
      console.log('\n失效（必须删除或替换）：');
      for (const r of dead) console.log(`  ${r.status || r.error}\t${r.id}\t${r.url}`);
    }
    if (warn.length) {
      console.log('\n存疑（建议浏览器人工确认）：');
      for (const r of warn) console.log(`  ${r.status}\t${r.id}\t${r.note}\t${r.url}`);
    }
  }

  // 回填模式（--write）是数据维护动作，即使存在失效条目也算执行成功；
  // 只校验不写时，用退出码提示「有失效/存疑需要处理」，方便接进 CI 或批处理。
  process.exitCode = args.write ? 0 : dead.length || warn.length ? 1 : 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((e) => {
    console.error('[check-links] 运行失败:', e);
    process.exitCode = 2;
  });
}
