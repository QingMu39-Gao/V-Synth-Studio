#!/usr/bin/env node
/**
 * 给安装包文件名补 `beta` 后缀。
 *
 *     node tools/rename-bundles-beta.mjs
 *
 * 安装包名字里的版本段天生是纯数字：Windows Installer 的 `ProductVersion` 只吃 `x.y.z`
 * （所以 `Cargo.toml` 是纯数字，MSI 叫 `…_x.y.z_x64_zh-CN.msi`），DMG 同理。
 * 而用户看到的版本（`config_file.rs::APP_VERSION` = 版本 + `beta`）带后缀 —— 文件名
 * 要跟它一致，这一步就是唯一的补救点。
 *
 * ⚠️ 必须在**传 artifact 与冒烟之前**跑：后面几步都按 `*.msi` / `*.dmg` 取件。
 * ⚠️ `productName` 从 `tauri.conf.json` 读，不在这里再抄一份 —— 抄了就会漂。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {PLATFORM} from './assets.mjs'
import {HERE, say} from './lib.mjs'

const BUNDLE = path.join(HERE, 'src-tauri/target/release/bundle')
const productName = JSON.parse(fs.readFileSync(path.join(HERE, 'src-tauri/tauri.conf.json'), 'utf8')).productName

/** 每个平台出哪些件（扩展名 → 所在子目录）。 */
const KINDS = {
  macos: [{sub: 'dmg', ext: '.dmg'}],
  windows: [{sub: 'msi', ext: '.msi'}],
  // deb 的名字是 `<productName>_<x.y.z>_<arch>.deb`（见 tauri-bundler 的 debian.rs），
  // 与 MSI 一样在版本段后面补 beta。
  linux: [{sub: 'deb', ext: '.deb'}],
}

const kinds = KINDS[PLATFORM]
if (!kinds) {
  say(`✗ 这个脚本只覆盖 macOS / Windows / Linux，当前平台是 ${PLATFORM}`)
  process.exit(1)
}

for (const {sub, ext} of kinds) {
  const dir = path.join(BUNDLE, sub)
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(ext)) : []
  if (files.length !== 1) {
    say(`✗ 期望 ${sub}/ 下恰好一个 ${ext}，实际 ${files.length} 个`)
    process.exit(1)
  }

  const old = files[0]
  // 在版本段后面补 beta：`<productName>_<x.y.z>_…` → `<productName>_<x.y.z>beta_…`
  const re = new RegExp(`^(${productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[0-9]+\\.[0-9]+\\.[0-9]+)_`)
  const next = old.replace(re, '$1beta_')
  if (next === old) {
    say(`✗ ${old} 的名字里没匹配到版本段 —— 产物命名规则变了？`)
    process.exit(1)
  }

  fs.renameSync(path.join(dir, old), path.join(dir, next))
  say(`${ext}: ${next}`)
}
