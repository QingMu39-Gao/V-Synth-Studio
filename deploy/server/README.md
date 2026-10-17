# 发布目录（`deploy/server`）

自建更新源的服务端一侧：往两个目录丢文件，客户端就能看到。

## 怎么用

**发新版** —— 把安装包丢进 `/var/www/vss/dl/`，文件名必须带版本段：

```
v-synth-studio_1.4.2_x64-setup.exe     → downloads.windows
v-synth-studio_1.4.2beta_aarch64.dmg   → downloads.macos
v-synth-studio_1.4.2_amd64.deb         → downloads.linux
```

**发公告** —— 把 `*.txt` 丢进 `/var/www/vss/announce/`，文件名就是公告 id：

```
今晚维护.txt
```

**写发版说明** —— 编辑 `/var/www/vss/changelog.txt`（普通文本，不用管格式）：

```
修复了下载校验偶发失败
新增音轨分离的进度条
```

计划任务每分钟跑一次两个生成器，`version.json` 与 `announcement.json` 自动重写。

## 三条必须知道的约束

**文件名决定一切。** 版本段取 `<productName>_<x.y.z>[beta]_…`，抠不出三段数字的文件会被跳过
（会往 stderr 说一句）。同一平台有多个包时取**版本最高**的，同版本优先 `setup.exe`。
版本号在文件名里，是为了让新版本天然是一个新 URL —— 这是 `location /dl/` 能开长缓存的前提。

**公告 id 就是文件名。** 客户端按 id 记「已读」，所以：改文件名 = 发了一条新的（会再弹）；
只改内容不重弹。想让旧公告重新弹，换个文件名。

**过期时间不自动加。** 没写 `expires` 的公告永不过期。撤回就把文件删掉。
自动加「发布后 N 天过期」的后果是：一条忘了删的公告会在某天静默消失，事后无从排查。

## 公告文件格式

两种，靠有没有单独一行 `---` 区分。

**A｜第一行当标题**

```
今晚维护
23:00–24:00 期间无法登录。
请提前保存工作。
```

**B｜带元数据（第一行 `---` 之前全是 `键: 值`）**

```
title: 严重故障已修复
level: critical
expires: 2026-12-31T00:00:00Z
url: https://example.com/status
---
下载节点已恢复。
可以正常使用了。
```

可用的键：`title` / `level`（`info`、`warn`、`critical`，其余当 `info`）/ `expires` / `url`。
键名不分大小写。**没有 `---` 时这些不会被当成元数据** —— 所以 A 型里写 `title: xx` 就真的
只显示 `title: xx` 这一行，不是 bug。

`expires` 要 ISO 8601（`2026-12-31T00:00:00Z` 或带 `+08:00`）。写坏了客户端**当没过期**处理，
不会静默吞掉。

## 生成器输出的形状

`version.json`：

```json
{
  "version": "1.4.2",
  "min_version": "1.0.0",
  "force": false,
  "published_at": "…",
  "changelog": "",
  "downloads": {
    "windows": {"url": "…/v-synth-studio_1.4.2_x64-setup.exe", "size": 153000000, "sha256": "…"}
  }
}
```

`sha256` 与 `size` 都是**当场从文件算的**，不是手写 —— 手写必然漂，而漂的表现是
「用户下完被删文件并报校验失败」。

`min_version` 与 `force` 是脚本里写死的常量，不从文件名或任何旁路文件推断：这两项**线上立刻生效**，
`min_version` 写高了会把所有人挡在主界面外。要强制更新，手工改那两行。

`changelog` 读的是 `/var/www/vss/changelog.txt`（**不在** `dl/` 里，否则会被当成发布物扫一遍）。
文件不存在就是空串，客户端那边显示「这条发布没有写说明」。

⚠️ 说明**不能**直接写进 `version.json`：它每分钟被重写一次，手写的内容会在下一分钟被抹掉。
这是它必须有单独文件的原因。

**`dl/` 为空时**不是错误：脚本写一份 `version: "0.0.0"` + 空 `downloads` 的 JSON 并正常退出。
`0.0.0` 比任何已发布版本都低，客户端判「不是新版」后不会提示更新。写成失败退出的话，
计划任务每分钟红一次，宝塔里会永远挂着失败记录 —— 那种长期红点会让人开始忽略告警。

`announcement.json` 是**数组**（客户端 `announce.rs::items_from` 认数组那条分支），
按文件修改时间新的在前。启动弹窗对未读是**逐条弹**的，所以别一次丢十几个进去。

## 为什么不用 `tools/`

`tools/` 在 `tauri.conf.json` 的 `bundle.resources` 里被整体映射进安装包，
放进去会给每个用户多带一份用不到的 shell 脚本。`deploy/` 在随包范围外。

## 安装

```
sudo bash deploy/server/install.sh
```

装到 `/www/release/bin/`，并建好两个目录。它不改 nginx、不建计划任务 —— 那两件事在
`如何编译打包.md` 第六节，因为它们的失败方式不同（计划任务跑不起来是静默的，nginx 改错是 502）。

`install.sh` 幂等，且允许从 `/www/release/bin/` 自己再跑一次（会跳过拷贝，只补目录与权限）。

## 脚本

| 文件 | 作用 |
|---|---|
| `gen-version-json.sh` | 扫 `dl/` → `version.json` |
| `gen-announcement-json.sh` | 扫 `announce/` → `announcement.json` |
| `lib.sh` | 两者共用的 JSON 转义（`json_escape`） |
| `install.sh` | 装到 `/www/release/bin/`、建目录、补权限 |
| `test.sh` | 回归测试：`bash deploy/server/test.sh` |

改任何一个脚本后跑一次 `test.sh`。它钉的都是**静默失败**：少一个平台键、sha256 带了
`\` 转义前缀、公告正文被吃掉、BOM 混进标题、changelog 被覆盖 —— 这些都不报错，
只是客户端那边少了东西或者校验失败。
