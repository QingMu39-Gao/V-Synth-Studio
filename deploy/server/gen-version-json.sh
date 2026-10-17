#!/bin/bash
# 扫发布目录 → 生成 /api/version.json。由计划任务按分钟跑，人只需把安装包丢进发布目录。
#
# 判据都在客户端那侧（src-tauri/src/update.rs）：键名 windows/macos/linux、
# 文件名从 URL 末段取、sha256 必须 64 位小写十六进制。这里对不上的东西直接跳过，
# 绝不写进 JSON —— 写错一个摘要的表现是「用户下完被删文件」，比不更新更糟。
#
# ⚠️ 只认 <productName>_<x.y.z>[beta]_<其余>.<ext>，版本段必须是三段数字：
# 版本号在文件名里，就是为了让新版本 = 新 URL（旧缓存永不脏）。
#
# ⚠️ min_version / force 是写死的常量，不从文件名、不从任何旁路文件推断：
# 这两项线上立刻生效，min_version 高了会把所有人挡在主界面外。
set -euo pipefail

DL=${VSS_DL_DIR:-/var/www/vss/dl}
API=${VSS_API_DIR:-/var/www/vss/api}
BASE=${VSS_URL_BASE:-https://admin1.qingmu39.top/dl}
PRODUCT=${VSS_PRODUCT:-v-synth-studio}
OUT="$API/version.json"

# 扩展名 → JSON 里的平台键。同一个平台有多种包时优先 setup.exe（NSIS）。
declare -A EXT_PLATFORM=([exe]=windows [msi]=windows [dmg]=macos [deb]=linux)
declare -A EXT_RANK=([exe]=2 [msi]=1 [dmg]=1 [deb]=1)
declare -A best_name=() best_ver=() best_rank=()

[ -d "$DL" ] || { echo "发布目录不存在：$DL" >&2; exit 1; }
mkdir -p "$API"

# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# 版本比较：1.2.10 > 1.2.9（不能按字典序）
ver_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

for f in "$DL"/*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  ext=${name##*.}
  ext=${ext,,}
  plat=${EXT_PLATFORM[$ext]:-}
  [ -n "$plat" ] || continue
  # 从文件名抠版本段；抠不到就不是我们的包
  ver=$(printf '%s' "$name" |
    sed -n "s/^${PRODUCT}_\([0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\)[a-z]*_.*/\1/p")
  [ -n "$ver" ] || { echo "跳过（文件名里没有版本段）：$name" >&2; continue; }

  rank=${EXT_RANK[$ext]}
  cur=${best_name[$plat]:-}
  if [ -z "$cur" ] ||
     ver_gt "$ver" "${best_ver[$plat]}" ||
     { [ "$ver" = "${best_ver[$plat]}" ] && [ "$rank" -gt "${best_rank[$plat]}" ]; }; then
    best_name[$plat]=$name
    best_ver[$plat]=$ver
    best_rank[$plat]=$rank
  fi
done

[ ${#best_name[@]} -gt 0 ] || { echo "发布目录里没有可识别的安装包：$DL" >&2; exit 1; }

# 顶层 version 取各平台里最高的那个
version=""
for plat in "${!best_ver[@]}"; do
  v=${best_ver[$plat]}
  if [ -z "$version" ] || ver_gt "$v" "$version"; then version=$v; fi
done

tmp=$(mktemp "$API/.version.json.XXXXXX")
trap 'rm -f "$tmp"' EXIT

# 发版说明从 `$DL/../changelog.txt` 读（默认 `/var/www/vss/changelog.txt`）。
# 不放在 `$DL` 里是因为那个目录会被当成发布物扫一遍。
#
# ⚠️ 必须走旁路文件：这个 JSON 每分钟重写一次，直接把说明写进 JSON 会在下一分钟被抹掉。
# 文件不存在 = 说明为空（不是错误）。
CHANGELOG_FILE=${VSS_CHANGELOG_FILE:-$(dirname "$DL")/changelog.txt}
changelog=""
if [ -f "$CHANGELOG_FILE" ]; then
  changelog=$(sed '1s/^\xEF\xBB\xBF//' "$CHANGELOG_FILE" || true)
fi

{
  printf '{\n'
  printf '  "version": "%s",\n' "$version"
  printf '  "min_version": "1.0.0",\n'
  printf '  "force": false,\n'
  printf '  "published_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "changelog": "%s",\n' "$(printf '%s' "$changelog" | json_escape)"
  printf '  "downloads": {\n'
  sep=""
  for plat in windows macos linux; do
    name=${best_name[$plat]:-}
    [ -n "$name" ] || continue
    path="$DL/$name"
    # 只取第一列：sha256sum 在文件名含特殊字符时会给整行加 `\` 转义前缀，
    # 客户端要的是裸的 64 位小写十六进制。
    sum=$(sha256sum "$path" | awk '{print $1}' | tr -d '\\' | tr 'A-Z' 'a-z')
    printf '%s    "%s": {"url": "%s/%s", "size": %s, "sha256": "%s"}' \
      "$sep" "$plat" "$BASE" "$name" \
      "$(stat -c%s "$path")" \
      "$sum"
    sep=$',\n'
  done
  printf '\n  }\n}\n'
} >"$tmp"

# 原子替换：nginx 永远读不到半个 JSON（同名同目录才保证 rename 原子）
mv -f "$tmp" "$OUT"
trap - EXIT
chmod 644 "$OUT"
echo "已更新 $OUT（version=$version）"
