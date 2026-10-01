import { useEffect, useRef, useState } from 'react'
import { GlassSegmentedControl, GlassSwitch } from '@ttqtt/liquid-glass-react'
import { api } from '@/lib/api'
import { Button } from '@/components/Button'
import { DirectoryInput } from '@/components/DirPicker'
import { Field, TextArea, TextInput } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { Chip, Panel, PanelHead } from '@/components/Panel'
import type { PageProps, ToastTone } from './types'
import './Lyrics.css'

/**
 * 歌词：从网易云 / QQ 音乐搜歌 → 取歌词 → 导出 LRC / SRT / 封面 → 带去「文字 PV」。
 *
 * 功能清单与文案来自已退役的旧前端（**功能与文案没有丢**）。
 * 三条路取词，之后共用同一套预览 / 保存 / 带去 PV：
 *
 *   1. 搜索（`lyricsSearch` → 点一条 → `lyricsGet`）
 *   2. 粘贴链接（`lyricsParseLink`，**后端先判 QQ songmid 再判网易云 id=**，这里原样传 url）
 *   3. 本地 `.lrc` 导入（`lyricsImport`，返回和 `lyricsGet` 同一个形状，另有 `encoding`）
 *
 * ⚠️ **扫码登录已移除，别再写**：网易云始终回 `8821 请切换其他登录方式`，
 * 判断是服务端风控（`AGENTS.md` 第十节）。留了手机号验证码 + Cookie 两条路。
 * ⚠️ **测试时绝不要调 `lyricsSms`**（会真的发短信）。
 *
 * 登录态就是 config 里的一个 Cookie 字段（`neteaseCookie` / `qqCookie`），
 * 后端只回显脱敏占位「已设置」—— 所以界面上永远不回显真实值。
 */

/** 后端对已保存的 Cookie 只回显这个占位串（真实值不出后端） */
const MASK = '已设置'

/** 「用这段歌词做文字 PV」把 LRC 交给文字 PV 页用的 localStorage 键（**必须和 pv.js 一致**） */
const LS_PV_LYRICS = 'qingmu.pv.lyrics'

/** 导入文件时后端读到的编码 → 界面上给用户看的说法 */
const ENC_LABEL: Record<string, string> = {
  'utf-8': 'UTF-8',
  gbk: 'GBK',
  unknown: '编码没认出来',
}

const SOURCES = [
  { value: 'netease', label: '网易云' },
  { value: 'qq', label: 'QQ 音乐' },
]

const MODES = [
  { value: 'both', label: '对照' },
  { value: 'orig', label: '只看原文' },
  { value: 'trans', label: '只看译文' },
]

/**
 * 本页自己攒的「这首歌」形状（**后端真实回包见 `lib/api.ts` 的 `LyricsDoc` / `LyricsHit`**）。
 *
 * 三条取词路最后都并成这一个形状：搜索结果（有 `id`）、接口取词（`id` 在外层，`song` 里没有）、
 * 本地导入（`id` 是完整路径）。留一份本地声明是因为要的是「界面自己拼出来的」类型，
 * 而 `api.ts` 那两个类型文件私有（只服务于它自己的方法签名）。
 *
 * ⚠️ 调用点**已经不需要 `as unknown as` 断言了**：`api.ts` 的回包类型现在与后端源码一致
 * （`lyrics.rs` 的 `fetch` / `import_file`、`server/lyrics.rs` 的各路由），直接用返回值即可。
 * 要改形状就改 `api.ts`，别照着这里的类型去改后端。
 */
interface LyricSong {
  /** 只在搜索结果里有；取词响应里的 `song` 不带 id */
  id?: string | number
  name?: string
  artists?: string
  album?: string
  cover?: string
  durationSec?: number
}
interface LyricFile {
  source?: string
  id?: string | number
  song?: LyricSong
  lyric?: string
  trans?: string
  encoding?: string
}

/** 当前这首歌 —— 三条取词路最后都落成这一个形状 */
interface Current extends LyricFile {
  id: string | number
  source: string
}

/** 归一化成一个字符串 id（网易云是数字，QQ 是 songmid，导入是完整路径） */
const asId = (id: string | number | undefined): string => (id === undefined || id === null ? '' : String(id))

/* ══════════════════════════════════════════════════════════ 歌词文本工具 ══ */

/**
 * 解析 LRC 成 `[{ ms, text }]`（只用来在界面上对齐显示，落盘由后端负责）。
 * 支持 `[mm:ss]` / `[mm:ss.SS]` / `[mm:ss:SS]` 以及一行多个时间戳。
 */
function parseLrc(text: string | null | undefined): { ms: number; text: string }[] {
  const out: { ms: number; text: string }[] = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const re = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g
    const times: number[] = []
    let m: RegExpExecArray | null
    let end = 0
    while ((m = re.exec(line))) {
      times.push(toMs(m[1], m[2]))
      end = re.lastIndex
    }
    const content = line.slice(end).trim()
    if (!times.length || !content) continue
    for (const ms of times) out.push({ ms, text: content })
  }
  return out.sort((a, b) => a.ms - b.ms)
}

/** `"02:345"` / `"02.34"` → 毫秒，毫秒位数按 1 位 ×100、2 位 ×10、3 位原样 */
function toMs(min: string, sec: string): number {
  const [s, frac = ''] = String(sec).split(/[.:]/)
  const digits = frac.slice(0, 3)
  const ms =
    digits.length === 1 ? Number(digits) * 100 : digits.length === 2 ? Number(digits) * 10 : Number(digits || 0)
  return (Number(min) * 60 + Number(s)) * 1000 + ms
}

/** 毫秒 → `mm:ss.xx`（预览用） */
function mmss(ms: number): string {
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`
}

/** 译文按时间戳对齐：先精确匹配，再容忍 ±50ms（和后端同一条规则） */
function alignTrans(text: string | null | undefined): (ms: number) => string {
  const list = parseLrc(text)
  const exact = new Map<number, string>()
  for (const l of list) if (!exact.has(l.ms)) exact.set(l.ms, l.text)
  return (ms) => {
    const hit = exact.get(ms)
    if (hit !== undefined) return hit
    const near = list.find((l) => Math.abs(l.ms - ms) <= 50)
    return near ? near.text : ''
  }
}

const fmtDuration = (sec?: number): string =>
  sec ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : ''

/** `C:\a\b\歌.lrc` → `歌.lrc` */
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

/* ══════════════════════════════════════════════════════════════════ 视图 ══ */

export function Lyrics({ state, onNavigate, onRefreshState, onToast }: PageProps) {
  const config = state?.config ?? {}

  const [source, setSource] = useState<string>('netease')
  const [keyword, setKeyword] = useState('')
  const [hits, setHits] = useState<LyricSong[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)

  const [url, setUrl] = useState('')
  const [pasteLoading, setPasteLoading] = useState(false)
  const [importing, setImporting] = useState(false)

  const [doc, setDoc] = useState<LyricFile | null>(null)
  const [current, setCurrent] = useState<Current | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)

  const [mode, setMode] = useState('both')
  const [format, setFormat] = useState('lrc')
  const [bilingual, setBilingual] = useState(true)

  const [outDir, setOutDir] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [coverLoading, setCoverLoading] = useState(false)
  const [saved, setSaved] = useState('')

  const [phone, setPhone] = useState('')
  const [captcha, setCaptcha] = useState('')
  const [smsLeft, setSmsLeft] = useState(0)
  const [loginMsg, setLoginMsg] = useState('')
  const [loginTone, setLoginTone] = useState<ToastTone>('warn')
  const [busy, setBusy] = useState(false)
  const [nickname, setNickname] = useState('')
  const [neteaseCookie, setNeteaseCookie] = useState('')
  const [qqCookie, setQqCookie] = useState('')

  /**
   * `edited` —— 用户手动改过输出目录之后，设置页里的默认值不再盖掉它。
   * `init` —— 默认目录**只为首次拿到 state 时填一次**（state 刷新不该覆盖用户的选择）。
   */
  const flags = useRef({ edited: false, init: false })
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (flags.current.init || !state) return
    flags.current.init = true
    setOutDir(state.paths?.outputDir ?? String(config.outputDir ?? ''))
    // config 只在首帧读一次，故意不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  /* 短信倒计时：既是防连点，也是免得用户一直点着发短信。离开页面时定时器要停掉 */
  useEffect(() => {
    if (smsLeft <= 0) return
    const id = window.setTimeout(() => setSmsLeft((n) => n - 1), 1000)
    return () => window.clearTimeout(id)
  }, [smsLeft])
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

  /** 一条提示只改内容：错误留在页面上，别只弹个 toast 就没了 */
  const setMsg = (text: string, tone: ToastTone = 'warn') => {
    setLoginMsg(text)
    setLoginTone(tone)
  }

  /* ── 搜索 ───────────────────────────────────────────────── */

  const doSearch = async () => {
    const kw = keyword.trim()
    if (!kw) {
      onToast('请先输入歌名或歌手', 'warn')
      return
    }
    setSearching(true)
    setSearchErr(null)
    try {
      const res = await api.lyricsSearch({ source: source as 'netease' | 'qq', keyword: kw })
      const list = res.songs ?? []
      setHits(list)
      if (!list.length) onToast('没有搜到结果', 'warn')
    } catch (e) {
      // 失败要留在结果区里，不能只闪一个 toast
      setHits(null)
      setSearchErr(errText(e))
      onToast(errText(e), 'err')
    } finally {
      setSearching(false)
    }
  }

  /* ── 取词：搜到的歌 / 粘贴的链接都走这里 ─────────────────── */

  const loadLyric = async (id: string | number, src: string) => {
    setPreviewErr(null)
    try {
      const res = await api.lyricsGet({ source: src as 'netease' | 'qq', id })
      setDoc(res)
      setCurrent({ ...res, id, source: src })
      // 文件名跟着歌名走，但**别踩掉用户已经填过的名字**
      setName((prev) => prev.trim() || [res.song?.name, res.song?.artists].filter(Boolean).join(' - '))
      if (!String(res.trans ?? '').trim()) onToast('这首歌没有翻译歌词，只能导出原文', 'info')
    } catch (e) {
      setPreviewErr(errText(e))
      onToast(errText(e), 'err')
    }
  }

  /* ── 粘贴链接直接解析 ───────────────────────────────────── */

  const doParseLink = async () => {
    const u = url.trim()
    if (!u) {
      onToast('请先粘贴歌曲链接', 'warn')
      return
    }
    setPasteLoading(true)
    try {
      // url 原样传：后端先判 QQ songmid 再判网易云 id=，前端不猜（见 lyric.rs 的注释）
      const res = await api.lyricsParseLink({ url: u })
      setSource(res.source)
      // 解析出来直接拉歌词（粘贴链接的场景不用再点一次）
      await loadLyric(res.id, res.source)
      onToast(`已识别为${res.source === 'qq' ? ' QQ 音乐' : '网易云'}：${res.id}`, 'ok')
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setPasteLoading(false)
    }
  }

  /* ── 本地 .lrc 导入 ─────────────────────────────────────── */

  const importPath = async (path: string) => {
    setImporting(true)
    setPreviewErr(null)
    try {
      const res = await api.lyricsImport({ path })
      const id = res.id ?? path
      setDoc(res)
      setCurrent({ ...res, id, source: res.source ?? 'file' })
      setName((prev) => prev.trim() || [res.song?.name, res.song?.artists].filter(Boolean).join(' - '))
      if (res.encoding === 'unknown') {
        onToast('这个文件既不是 UTF-8 也不是 GBK，显示出来可能是乱码', 'warn')
      } else {
        onToast(res.encoding === 'gbk' ? '已按 GBK 读取本地歌词' : '已导入本地歌词', 'ok')
      }
    } catch (e) {
      setPreviewErr(errText(e))
      onToast(errText(e), 'err')
    } finally {
      setImporting(false)
    }
  }

  /* ── 保存 / 封面 ────────────────────────────────────────── */

  const saveLyric = async () => {
    if (!current) {
      onToast('请先选中一首歌并取到歌词', 'warn')
      return
    }
    setSaving(true)
    try {
      const res = (await api.lyricsSave({
        source: current.source,
        id: current.id,
        lyric: current.lyric,
        trans: current.trans,
        durationSec: current.song?.durationSec ?? 0,
        format,
        bilingual,
        outDir,
        name: name.trim(),
      }))
      onToast(`已保存 ${res.name ?? baseName(res.path)}`, 'ok')
      setSaved(res.path)
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setSaving(false)
    }
  }

  const downloadCover = async () => {
    const cover = current?.song?.cover
    if (!cover) {
      onToast('这首歌没有封面，或还没选中歌曲', 'warn')
      return
    }
    setCoverLoading(true)
    try {
      const res = (await api.lyricsCover({
        url: cover,
        outDir,
        name: name.trim() || current?.song?.name || 'cover',
      }))
      onToast(`封面已保存 ${baseName(res.path)}`, 'ok')
      setSaved(res.path)
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setCoverLoading(false)
    }
  }

  /* ── 一键带去「文字 PV」─────────────────────────────────────
     交接方式：写 localStorage（同源，两边都读得到），再导航过去。
     不用 params 传：params 只在这次导航里存在，用户在 PV 页按一下 F5 就没了。
     带的是**原文 LRC 原文**，不自己拼双语 —— JIZURA 认 LRC 时间戳，也认
     `歌词|注音` 这种一行两段的写法，把两段 LRC 和格式说明一起交给它，
     比在这里猜它的语法稳妥（时间戳归它解析，自己不重复实现一遍）。 */
  const toTextPv = () => {
    const lyric = String(current?.lyric ?? '').trim()
    if (!lyric) {
      onToast('还没有选中歌曲，先搜一首或粘贴链接把歌词取回来', 'warn')
      return
    }
    const parts = [lyric]
    const trans = String(current?.trans ?? '').trim()
    // 只有双语开关打开、且这首真有译文时才带译文（和后端保存 LRC 的规则一致）
    if (bilingual && trans) parts.push(trans)
    if (parts.length > 1) {
      parts.push('# 上面第一段是原文、第二段是译文。请把译文放到「注釈」的位置：原文|译文（同一行用竖线分开），别当成两句歌词。')
    }
    try {
      localStorage.setItem(LS_PV_LYRICS, parts.join('\n'))
    } catch (e) {
      // 存不下（隐私模式 / 配额满）就别硬跳 —— 跳过去是空的，用户只会以为功能坏了
      onToast(`歌词存不进浏览器缓存，没法带过去：${errText(e)}`, 'err')
      return
    }
    onNavigate('pv')
  }

  /* ── 登录（只有网易云有短信，两边的兜底都是 Cookie）───────── */

  const isQq = source === 'qq'
  const loginKey = isQq ? 'qqCookie' : 'neteaseCookie'
  const loggedIn = !!config[loginKey]
  const sourceLabel = isQq ? 'QQ 音乐' : '网易云'

  const sendSms = async () => {
    const p = phone.replace(/\D/g, '')
    if (p.length !== 11) {
      setMsg('请填 11 位手机号（不用填 +86）', 'err')
      onToast('手机号要 11 位数字', 'warn')
      return
    }
    setBusy(true)
    setMsg('正在发送验证码…', 'info')
    try {
      await api.lyricsSms(p)
      setSmsLeft(60)
      setMsg(`验证码已发到 ${p}，收到后填在下面。`, 'ok')
      onToast('验证码已发送', 'ok')
    } catch (e) {
      // 号码没注册 / 今天发太多 / 网络不通：原样显示网易云或本地给出的话
      setMsg(errText(e), 'err')
      onToast(errText(e), 'err')
      // 发失败要把按钮放回去（成功的话上面那句会接管它），
      // 否则用户得干等 60 秒才知道短信根本没发出去
      setSmsLeft(0)
    } finally {
      setBusy(false)
    }
  }

  const doLogin = async () => {
    const p = phone.replace(/\D/g, '')
    if (p.length !== 11) {
      setMsg('请填 11 位手机号（不用填 +86）', 'err')
      return
    }
    if (!captcha.trim()) {
      setMsg('请先填短信验证码', 'err')
      return
    }
    setBusy(true)
    setMsg('登录中…', 'info')
    try {
      const res = await api.lyricsCellphone(p, captcha.trim())
      setCaptcha('')
      setNickname(res.nickname ?? '')
      setMsg(
        res.nickname
          ? `登录成功：${res.nickname}　登录态已经保存，可以直接搜索取歌词了。`
          : '登录成功，登录态已经保存，可以直接搜索取歌词了。',
        'ok',
      )
      onToast(res.nickname ? `登录成功：${res.nickname}` : '登录成功', 'ok')
      await onRefreshState()
    } catch (e) {
      // 验证码错误 / 号码没注册 / 接口变更，都要原样显示出来
      setMsg(errText(e), 'err')
      onToast(errText(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  /** 退出登录：清掉当前来源的 Cookie。登录态就是 config 里一个字段，清空即退出 */
  const doLogout = async () => {
    setBusy(true)
    try {
      await api.lyricsLogout(source as 'netease' | 'qq')
      setNickname('')
      await onRefreshState()
      setNeteaseCookie('')
      setQqCookie('')
      setMsg('已退出登录。', 'ok')
      onToast('已退出登录', 'ok')
    } catch (e) {
      setMsg(`退出失败：${errText(e)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 保存 Cookie。
   * 从开发者工具整行复制出来的 Cookie 常带换行，而 Cookie 头里不能有换行 —— 折成一行再存。
   * 留空保存 = 清除（后端语义）。
   */
  const saveCookie = async (key: 'neteaseCookie' | 'qqCookie', raw: string, clear: (v: string) => void) => {
    const value = raw.replace(/\s*\r?\n\s*/g, ' ').trim()
    if (value === MASK) {
      onToast('输入框里是脱敏占位「已设置」，没有可保存的新值', 'warn')
      return
    }
    setBusy(true)
    try {
      await api.saveConfig({ [key]: value })
      await onRefreshState()
      clear('')
      if (key === 'neteaseCookie') {
        setNickname('')
        if (!value) setMsg('已清除网易云的登录态 Cookie，取歌词会退回未登录。', 'warn')
      }
      onToast(value ? 'Cookie 已保存' : 'Cookie 已清除', 'ok')
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  /* ── 预览用的派生值 ─────────────────────────────────────── */

  const lines = doc ? parseLrc(doc.lyric) : []
  const transAt = alignTrans(doc?.trans)
  const song = doc?.song ?? {}
  const label =
    current?.source === 'file'
      ? `本地文件${ENC_LABEL[doc?.encoding ?? ''] ? `（${ENC_LABEL[doc?.encoding ?? '']}）` : ''}`
      : current?.source === 'qq'
        ? 'QQ 音乐'
        : '网易云'

  return (
    <div className="lyrics-cols">
      {/* ── 左栏：取词的三个入口 ─────────────────────────────── */}
      <div className="lyrics-col">
        <Panel>
          <PanelHead title="搜索歌曲" desc="搜到之后点一条就能取歌词" />
          <div className="stack">
            <GlassSegmentedControl
              aria-label="歌词来源"
              items={SOURCES}
              value={source}
              onValueChange={(v) => {
                setSource(v)
                setHits(null)
                setSearchErr(null)
              }}
            />
            <Field
              label="关键词"
              hint={
                isQq
                  ? 'QQ 音乐走的是手机端搜索接口（桌面接口现在要签名，会返回空结果）。'
                  : '网易云的搜索结果里带专辑与时长，信息更全。'
              }
            >
              <div className="input-group">
                <TextInput
                  value={keyword}
                  placeholder="歌名 / 歌手，回车搜索（例如：千本桜）"
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doSearch()
                  }}
                />
                <Button variant="primary" icon="search" loading={searching} onClick={doSearch}>
                  搜索
                </Button>
              </div>
            </Field>

            {searchErr && <p className="lyrics-error">{searchErr}</p>}

            {hits === null ? (
              <p className="hint">搜到的歌会列在这里，点一条就开始取歌词。</p>
            ) : hits.length === 0 ? (
              <p className="hint">没有结果。换个关键词，或换一个来源再试。</p>
            ) : (
              <div className="lyrics-results">
                {hits.map((s, i) => (
                  <button
                    key={`${asId(s.id) || i}`}
                    type="button"
                    className="lyrics-result"
                    onClick={() => void loadLyric(s.id!, source)}
                  >
                    <Icon name="music" size={15} />
                    <span className="lyrics-result-text">
                      <span className="lyrics-name">{s.name || '(无标题)'}</span>
                      <span className="lyrics-sub">
                        {s.artists || '未知歌手'}
                        {s.album ? ` · ${s.album}` : ''}
                      </span>
                    </span>
                    {!!s.durationSec && <Chip>{fmtDuration(s.durationSec)}</Chip>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHead title="粘贴链接" desc="不想搜就复制链接过来；手上有 LRC 文件也可以直接读" />
          <div className="stack">
            <Field
              label="歌曲链接 / ID"
              hint="支持网易云歌曲链接 / 歌曲 ID，以及 QQ 音乐的 songDetail 链接 / songmid。"
            >
              <div className="input-group">
                <TextInput
                  value={url}
                  placeholder="粘贴歌曲链接，例如 https://music.163.com/#/song?id=186016"
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doParseLink()
                  }}
                />
                <Button icon="link" loading={pasteLoading} onClick={doParseLink}>
                  解析链接
                </Button>
              </div>
            </Field>

            <Field
              label="从文件导入（本地已有的 .lrc）"
              hint="选一个 .lrc 文件，读进来之后的预览、保存、带去「文字 PV」都和搜到的歌一样，只是来源标成「本地文件」。UTF-8 与 GBK（国内老歌词常见）都能读，读的是哪种会写在歌词预览的来源那一行。译文尽量拆出来：`原文 / 译文` 这种一行两段、以及前后两段同时间轴的写法都认；拆不出来就整份当原文。"
            >
              <DirectoryInput
                value=""
                placeholder="选择一个 .lrc 文件…"
                onChange={(p) => {
                  if (p) void importPath(p)
                }}
              />
            </Field>
            {importing && <p className="hint">正在读取本地歌词…</p>}
          </div>
        </Panel>

        <Panel>
          <PanelHead
            title="登录"
            desc="手机号验证码，或者填浏览器里的 Cookie"
            extra={
              <div className="lyrics-controls">
                <Chip tone={loggedIn ? 'ok' : 'default'}>
                  {sourceLabel}：
                  {loggedIn
                    ? !isQq && nickname
                      ? `已登录为 ${nickname}`
                      : '已登录'
                    : '未登录'}
                </Chip>
                {loggedIn && (
                  <Button size="sm" variant="ghost" icon="x" loading={busy} onClick={doLogout}>
                    退出登录
                  </Button>
                )}
              </div>
            }
          />
          <div className="stack">
            {/* 扫码登录已移除（服务端风控，见 AGENTS.md 第十节）—— 别再往这里加回来 */}
            <Field
              label="手机号 + 短信验证码（推荐，只有网易云支持）"
              hint="先点「发送验证码」，收到短信后把验证码填在下面点「登录」。没收到就别重复点，多半是号码不对或今天发得太多。"
            >
              <div className="input-group">
                <TextInput
                  type="tel"
                  inputMode="numeric"
                  maxLength={11}
                  autoComplete="off"
                  value={phone}
                  placeholder="11 位手机号，不用填 +86"
                  onChange={(e) => setPhone(e.target.value)}
                />
                <Button
                  loading={busy && smsLeft === 0}
                  disabled={smsLeft > 0}
                  onClick={sendSms}
                >
                  {smsLeft > 0 ? `${smsLeft} 秒后可重发` : '发送验证码'}
                </Button>
              </div>
            </Field>
            <Field label="短信验证码" hint="登录成功后登录态存在本机（等同网页版登录），搜索、取歌词、下封面都会带上它。">
              <div className="input-group">
                <TextInput
                  inputMode="numeric"
                  maxLength={10}
                  autoComplete="off"
                  value={captcha}
                  placeholder="手机收到的短信验证码"
                  onChange={(e) => setCaptcha(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doLogin()
                  }}
                />
                <Button variant="primary" icon="shield" loading={busy} disabled={!captcha.trim()} onClick={doLogin}>
                  登录
                </Button>
              </div>
            </Field>

            {loginMsg && (
              <p className="lyrics-login-msg" data-tone={loginTone}>
                {loginMsg}
              </p>
            )}

            <Field
              label="网易云 Cookie（兜底：发不出短信、或想直接用浏览器里那个登录态时用）"
              hint="保存后不会回显真实值，只会显示「已设置」（输入框保持空白）。留空保存 = 清除。"
            >
              <TextArea
                rows={3}
                spellCheck={false}
                value={neteaseCookie}
                placeholder="MUSIC_U=...　（怎么拿见下面的步骤说明）"
                onChange={(e) => setNeteaseCookie(e.target.value)}
              />
              <span className="lyrics-controls">
                <Button
                  size="sm"
                  variant="primary"
                  icon="save"
                  onClick={() => void saveCookie('neteaseCookie', neteaseCookie, setNeteaseCookie)}
                >
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  onClick={() => void saveCookie('neteaseCookie', '', setNeteaseCookie)}
                >
                  清除
                </Button>
              </span>
            </Field>
            <p className="lyrics-login-msg">⚠ 这个值等同于你的账号登录态，别分享给别人、别截图发出来。</p>

            {/* 怎么拿 Cookie：用户基本都不知道，写细一点，能照着做 */}
            <details className="lyrics-help">
              <summary>怎么拿到 Cookie？（点开看步骤）</summary>
              <div className="lyrics-help-body">
                <ol>
                  <li>
                    用浏览器打开 <code>https://music.163.com</code> 并登录（手机号、验证码都行）。
                  </li>
                  <li>
                    按 <kbd>F12</kbd> 打开开发者工具。
                  </li>
                  <li>
                    切到 <strong>Application</strong> 标签（中文界面是「应用程序」，在顶部一排里）。
                  </li>
                  <li>
                    左边展开 <strong>Cookies</strong> → 点 <code>https://music.163.com</code>。
                  </li>
                  <li>
                    在列表里找到名为 <code>MUSIC_U</code> 的那一行，双击 Value 那一格，全选复制。
                  </li>
                  <li>回到这里粘进上面的框，点「保存」。</li>
                </ol>
                <p className="lyrics-login-msg">
                  只复制 MUSIC_U 那一格的值就行（保存时会自动补上 MUSIC_U=）；把整行 Cookie（MUSIC_U=xxx; __csrf=yyy; …）整个粘进来也能用。
                </p>
                <p className="lyrics-alert" data-tone="warn">
                  MUSIC_U 是 HttpOnly cookie，在 Console 里敲 document.cookie 是看不到它的 —— 网上教程那招在这里没用，必须按上面的步骤在 Application → Cookies 里找。
                </p>
                <p className="lyrics-alert" data-tone="err">
                  MUSIC_U 等同账号登录态：不要发给别人、不要贴到群里、不要截图发出来。谁拿到它就能用你的账号。
                </p>
              </div>
            </details>

            <Field label="QQ 音乐 Cookie（可选）" hint="QQ 音乐没有短信登录，只能粘贴 Cookie。多数歌词不填也能取。">
              <TextArea
                rows={2}
                spellCheck={false}
                value={qqCookie}
                placeholder="QQ 音乐 Cookie（可选，多数歌词不填也能取）"
                onChange={(e) => setQqCookie(e.target.value)}
              />
              <span className="lyrics-controls">
                <Button size="sm" icon="save" onClick={() => void saveCookie('qqCookie', qqCookie, setQqCookie)}>
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  onClick={() => void saveCookie('qqCookie', '', setQqCookie)}
                >
                  清除
                </Button>
              </span>
            </Field>
          </div>
        </Panel>
      </div>

      {/* ── 右栏：预览 + 保存 ────────────────────────────────── */}
      <div className="lyrics-col">
        <Panel>
          <PanelHead
            title="歌词预览"
            desc="原文与译文分开显示"
            extra={<GlassSegmentedControl aria-label="预览方式" items={MODES} value={mode} onValueChange={setMode} />}
          />
          <div className="stack">
            {doc ? (
              <div className="lyrics-meta">
                {song.cover ? (
                  // 浏览器直连封面 CDN 不受程序里的代理影响；拉不到就用「下载封面」（那条走后端）
                  <img
                    className="lyrics-cover"
                    src={song.cover}
                    alt="封面"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none'
                    }}
                  />
                ) : null}
                <div className="lyrics-meta-text">
                  <span className="lyrics-name">{song.name || '(未取到歌名)'}</span>
                  <span className="lyrics-sub">{[song.artists, song.album].filter(Boolean).join(' · ')}</span>
                  <span className="lyrics-source">
                    {label} · <span className="lyrics-id">{asId(current?.id)}</span>
                    {song.durationSec ? ` · ${fmtDuration(song.durationSec)}` : ''}
                  </span>
                </div>
              </div>
            ) : (
              <p className="hint">
                还没有选中歌曲。上面搜一首歌、粘贴链接，或从文件导入 LRC ；歌词取回来会显示在这里。
              </p>
            )}

            {previewErr && <p className="lyrics-error">{previewErr}</p>}

            {doc &&
              (lines.length === 0 ? (
                <p className="lyrics-alert" data-tone="warn">
                  这首歌的歌词里没有可识别的时间轴，无法导出 LRC / SRT。
                </p>
              ) : (
                <div className="lyrics-lines">
                  {lines.map((l, i) => {
                    const tr = transAt(l.ms)
                    return (
                      <div className="lyrics-line" key={`${l.ms}-${i}`}>
                        <span className="lyrics-time">{mmss(l.ms)}</span>
                        {mode !== 'trans' && <span className="lyrics-orig">{l.text}</span>}
                        {mode !== 'orig' && <span className="lyrics-trans">{tr}</span>}
                      </div>
                    )
                  })}
                </div>
              ))}
          </div>
        </Panel>

        <Panel>
          <PanelHead title="保存" desc="LRC 给播放器，SRT 给剪辑 / 字幕" />
          <div className="stack">
            <Field
              label="格式"
              hint="双语导出：LRC 会在原文下面加一行同时间戳的译文；SRT 会把译文放在同一条字幕的第二行。"
            >
              <span className="lyrics-controls">
                <GlassSegmentedControl
                  aria-label="导出格式"
                  items={[
                    { value: 'lrc', label: 'LRC' },
                    { value: 'srt', label: 'SRT' },
                  ]}
                  value={format}
                  onValueChange={setFormat}
                />
                <span className="spacer" />
                <span className="field-hint">双语</span>
                <GlassSwitch aria-label="双语导出" checked={bilingual} onCheckedChange={setBilingual} />
              </span>
            </Field>

            <Field
              label="输出目录"
              hint={`默认是系统下载目录（设置页可改）：${state?.paths?.outputDir || '未读取到'}`}
            >
              <DirectoryInput
                value={outDir}
                placeholder="歌词保存目录…"
                onChange={(v) => {
                  flags.current.edited = true
                  setOutDir(v)
                }}
              />
            </Field>

            <Field label="文件名" hint="不用加扩展名，按上面的格式自动补 .lrc / .srt。文件一律 UTF-8 编码。">
              <TextInput
                value={name}
                placeholder="文件名（默认：歌名 - 歌手）"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <div className="btn-row">
              <Button variant="primary" icon="save" loading={saving} onClick={saveLyric}>
                保存歌词
              </Button>
              <Button icon="image" loading={coverLoading} onClick={downloadCover}>
                下载封面
              </Button>
            </div>

            {saved && (
              /* 路径文字放 span 里：库的按钮带 `.lg-*` 类，直接塞进 <p> 会把整行染成次要色 */
              <div className="lyrics-saved">
                <span>已写入：{saved}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="external"
                  onClick={() =>
                    api.fsReveal(saved).catch((e: unknown) => onToast(errText(e), 'err'))
                  }
                >
                  打开所在目录
                </Button>
              </div>
            )}

            <p className="lyrics-saved">想直接出视频（动态歌词 MP4 / PNG 序列）：把这段歌词带去「文字 PV」。</p>
            <div className="btn-row">
              <Button icon="film" onClick={toTextPv}>
                用这段歌词做文字 PV
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}
