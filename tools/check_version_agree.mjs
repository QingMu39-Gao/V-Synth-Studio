#!/usr/bin/env node
/**
 * 版本号只有一个真源 —— `src-tauri/Cargo.toml` 的 `version`。
 *
 *     node tools/check_version_agree.mjs        # 出问题返回 1
 *
 * 查三件**在本地看不出来**的漂移（都是「改了这里、忘了那里」的形状）：
 *
 *   ① `Cargo.lock` 里那个包自己的版本与 `Cargo.toml` 一致 —— 手改版本号而没让
 *      cargo 重算 lock 时，`cargo build --locked`（CI 用的那个）会直接失败；
 *   ② `tauri.conf.json` **不写** `version` —— 写了会盖掉 Cargo 的值，而 Tauri
 *      按它定界面显示的版本与安装包文件名；
 *   ③ `package.json` 不写 `version` —— 那是 npm 惯例字段，与程序版本无关，
 *      留着只会被读成「第二个真源」，然后各自漂（它已经漂过一次）。
 *
 * 真源与派生关系写在 `src-tauri/src/ipc/config_file.rs::APP_VERSION` 上面。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {HERE, isMain, say} from './lib.mjs'

const PKG = 'v-synth-studio'

/** `[package]` 段里的 `version = "x.y.z"`。 */
function cargoTomlVersion() {
  const file = path.join(HERE, 'src-tauri', 'Cargo.toml')
  if (!fs.existsSync(file)) return {error: `找不到 ${file}`}
  /* ⚠️ 只认**第一个** `version =`：`Cargo.toml` 后面 `[dependencies]` 里的
     `foo = { version = "..." }` 形状不同，而 `[package]` 段永远是第一个。 */
  const m = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(file, 'utf8'))
  return m ? {version: m[1]} : {error: 'Cargo.toml 的 [package] 段里没有 version'}
}

/** `Cargo.lock` 里那个包自己的条目。 */
function cargoLockVersion() {
  const file = path.join(HERE, 'src-tauri', 'Cargo.lock')
  if (!fs.existsSync(file)) return {error: `找不到 ${file}`}
  /* ⚠️ 先把 CRLF 归一：`core.autocrlf=true` 的机器上（含 Windows CI 的干净检出）
     `Cargo.lock` 是 CRLF，而 `cargo` 在本机目录里写的是 LF —— 同一份内容两种行尾，
     只认 `\n` 的匹配在那种机器上会报「没有这个条目」，把版本号检查变成环境依赖。 */
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const re = new RegExp(`\\[\\[package\\]\\]\\nname = "${PKG}"\\nversion = "([^"]+)"\\n`)
  const m = re.exec(text)
  return m ? {version: m[1]} : {error: `Cargo.lock 里没有 ${PKG} 自己的条目`}
}

/** 某个 json 里有没有顶层 `version`（有就是第二个真源）。 */
function jsonVersion(rel) {
  const file = path.join(HERE, rel)
  if (!fs.existsSync(file)) return {error: `找不到 ${file}`}
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return {error: `${rel} 不是合法 JSON：${e.message}`}
  }
  return {version: typeof data.version === 'string' ? data.version : null}
}

export function checkVersionAgree() {
  const bad = []
  const toml = cargoTomlVersion()
  const lock = cargoLockVersion()

  if (toml.error) return [toml.error]
  if (lock.error) bad.push(lock.error)
  else if (lock.version !== toml.version) {
    bad.push(`Cargo.lock 里 ${PKG} 是 ${lock.version}，Cargo.toml 是 ${toml.version} —— 跑一次 cargo 让它重算 lock`)
  }

  for (const rel of ['src-tauri/tauri.conf.json', 'package.json']) {
    const got = jsonVersion(rel)
    if (got.error) {
      bad.push(got.error)
      continue
    }
    if (got.version !== null) {
      bad.push(`${rel} 里写了 version=${got.version} —— 版本号真源只有 Cargo.toml（${toml.version}），这里写了就会各自漂`)
    }
  }
  return bad
}

function main() {
  const bad = checkVersionAgree()
  if (bad.length) {
    for (const item of bad) say(`✗ ${item}`)
    return 1
  }
  say(`✓ 版本号只有一处：Cargo.toml ${cargoTomlVersion().version}`)
  return 0
}

if (isMain(import.meta.url)) process.exit(main())
