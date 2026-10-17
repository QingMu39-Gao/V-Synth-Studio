#!/bin/bash
# 扫公告目录里的 *.txt → 生成 /api/announcement.json。丢一个文件就是一条公告。
#
# 文件名（去扩展名）就是公告 id：客户端按 id 记「已读」，所以同一个文件永远只弹一次。
# 想让一条公告重新弹，改文件名（= 换 id）；改内容不会重弹，这是有意的。
#
# 文件格式（两种都认）：
#   A) 第一行是标题，其余行是正文。
#   B) 有单独一行 `---` 时，它**上面**是 `键: 值` 元数据（title/level/expires/url），下面全是正文。
# 只认 A 的时候，第一行写 "title: xxx" 也只是普通标题 —— 元数据只在出现 `---` 时才解析。
#
# ⚠️ 输出是**数组**：客户端 `announce.rs::items_from` 认数组，且按 date 新的在前排。
# 启动弹窗对未读是**逐条弹**的，所以别一次丢十几个文件进去。
#
# ⚠️ 过期时间不自动加：没写 expires 的公告永不过期，撤回就把文件删掉。
# 自动加「发布后 N 天过期」会让一条忘了删的公告在某天静默消失，排查时无从下手。
set -euo pipefail

SRC=${VSS_ANNOUNCE_DIR:-/var/www/vss/announce}
API=${VSS_API_DIR:-/var/www/vss/api}
OUT="$API/announcement.json"
# 客户端 MAX_ITEMS 是 50，超出的会被它截掉；这里先按 50 截，免得 JSON 白长。
LIMIT=${VSS_ANNOUNCE_LIMIT:-50}

[ -d "$SRC" ] || { echo "公告目录不存在：$SRC" >&2; exit 1; }
mkdir -p "$API"

# JSON 字符串转义（`json_escape`）在 lib.sh 里：两个生成器都要写 JSON，转义只有一份。
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# 元数据一项（只在第一条 `---` 之前找，键名不分大小写）。从 stdin 读。
meta_of() {
  awk -v k="$1" '
    /^---[[:space:]]*$/ { exit }
    {
      i = index($0, ":")
      if (i > 0) {
        key = substr($0, 1, i-1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
        if (tolower(key) == tolower(k)) {
          v = substr($0, i+1)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
          print v
          exit
        }
      }
    }
  '
}

tmp=$(mktemp "$API/.announcement.json.XXXXXX")
trap 'rm -f "$tmp"' EXIT

count=0
{
  printf '[\n'
  # 新的在前：按修改时间倒序。文件名带空格也能正确处理（读入数组）。
  while IFS= read -r -d '' f; do
    name=$(basename "$f")
    id=${name%.*}
    [ -n "$id" ] || continue

    # 去掉 UTF-8 BOM：在 Windows 上编辑过的 txt 几乎必然带它，否则它会成为标题的首字符，
    # 界面上是标题前多一个乱码方块。
    content=$(sed '1s/^\xEF\xBB\xBF//' "$f" || true)

    if printf '%s\n' "$content" | grep -qx -- '---' 2>/dev/null; then
      title=$(printf '%s\n' "$content" | meta_of title)
      level=$(printf '%s\n' "$content" | meta_of level)
      expires=$(printf '%s\n' "$content" | meta_of expires)
      url=$(printf '%s\n' "$content" | meta_of url)
      body=$(printf '%s\n' "$content" | awk '/^---[[:space:]]*$/ {f=1; next} f' || true)
    else
      # grep/sed 在「没匹配」时返回非 0，配合 `set -e` 会直接退出整个脚本 ——
      # 空文件、只有空行的文件都是正常输入，一律用 `|| true` 兜住。
      title=$(printf '%s\n' "$content" | grep -v '^[[:space:]]*$' | sed -n '1p' || true)
      level=""
      expires=""
      url=""
      # 只跳过**第一个**非空行（它是标题），其余全算正文；
      # 写成 `NF{found=1;next} found` 会把所有非空行都吃掉，正文永远是空。
      body=$(printf '%s\n' "$content" | awk 'NF && !found { found=1; next } found' || true)
    fi

    # 标题与正文都空 → 客户端也会丢，这里先跳
    if [ -z "${title//[[:space:]]/}" ] && [ -z "${body//[[:space:]]/}" ]; then
      echo "跳过（没有标题也没有正文）：$name" >&2
      continue
    fi

    case "${level,,}" in
      warn|warning) level=warn ;;
      critical|danger) level=critical ;;
      *) level=info ;;
    esac

    date=$(date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ)

    [ $count -gt 0 ] && printf ',\n'
    printf '  {"id": "%s", "title": "%s", "body": "%s", "date": "%s", "level": "%s"' \
      "$(printf '%s' "$id" | json_escape)" \
      "$(printf '%s' "$title" | json_escape)" \
      "$(printf '%s' "$body" | json_escape)" \
      "$date" "$level"
    [ -n "$url" ] && printf ', "url": "%s"' "$(printf '%s' "$url" | json_escape)"
    [ -n "$expires" ] && printf ', "expires_at": "%s"' "$(printf '%s' "$expires" | json_escape)"
    printf '}'
    count=$((count+1))
    [ $count -ge $LIMIT ] && break
  done < <(find "$SRC" -maxdepth 1 -type f -name '*.txt' -printf '%T@ %p\0' 2>/dev/null |
           sort -z -rn | cut -z -d' ' -f2-)
  printf '\n]\n'
} >"$tmp"

mv -f "$tmp" "$OUT"
trap - EXIT
chmod 644 "$OUT"
echo "已更新 $OUT（$count 条）"
