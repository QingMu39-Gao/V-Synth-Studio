#!/usr/bin/env bash
# 从 `$VSS_SPONSOR_FILE` 生成 `sponsors.json`（感谢名单）。
#
# 格式：一行一个 ID，空行与 `#` 开头的行忽略。没有别的字段 —— 名单要的是
# 「原样照抄对方的写法」，加元数据只会让维护变麻烦。
#
# 与另外两个生成器同一套规矩：先写临时文件、自检 JSON、再 `mv` 原子替换，
# 所以 nginx 永远读不到半个文件，坏内容也顶不掉好内容。

set -euo pipefail

# ⚠️ locale 必须显式设成 UTF-8。下面用 `${#line}` 与 `${line:0:N}` 做字符级截断，
# 而这两者在 C locale 下按**字节**数：日文/emoji 名字会被切在字符中间，产出一个
# 孤立的 UTF-8 起始字节。那种字节序列 JSON 解析器照样接受（它们是按字节透传的），
# 所以下面的 JSON 校验闸**拦不住**，只有客户端的 serde 才会报错 ——
# 表现为「名单里一有长日文名，客户端就一直取不到」。
export LC_ALL=C.UTF-8
export LANG=C.UTF-8

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

API=${VSS_API_DIR:-/var/www/vss/api}
SRC=${VSS_SPONSOR_FILE:-/var/www/vss/sponsors.txt}
OUT="$API/sponsors.json"

# 单条长度上限（字符）。与客户端的 `sponsors.rs::NAME_LIMIT` 同一个值：
# 服务端截断是让「文件里误贴了一整段说明」不至于发上去，客户端那次是防御。
NAME_LIMIT=60
# 总条数上限。人工维护的名单几十条算正常；上千条说明文件写错了。
LIMIT=500

mkdir -p "$API"

# 名单文件不存在：什么都不写，正常退出。
#
# 与 `gen-version-json.sh` 处理空 `dl/` 的理由相同：这份文件可能长期不存在
# （还没开始维护），每分钟失败一次会让计划任务永远挂着红记录。
#
# ⚠️ 不写 `[]`：空数组在客户端等价于「取不到」，会回落缓存，于是「文件被删」
# 反而让用户看到旧名单。**保留上一份产物**才是对的 —— 文件不在不是指令。
if [ ! -f "$SRC" ]; then
  echo "没有名单文件（$SRC），保持上一份产物不动"
  exit 0
fi

tmp=$(mktemp "$API/.sponsors.json.XXXXXX")
trap 'rm -f "$tmp"' EXIT

count=0
# 先清洗成「一行一个 ID」的中间文件，再统一序列化。
# ⚠️ 两步分开：把 `printf '[\n'` 和循环写进同一个重定向里，`[` 会被
# 后面那次 `read` 当成一条数据读回来（实测产出第一个元素是 "["）。
# 去掉 UTF-8 BOM（Windows 记事本保存会带），否则第一个 ID 前面多一个乱码方块
sed '1s/^\xEF\xBB\xBF//' "$SRC" >"$tmp.lines"
{
  while IFS= read -r line || [ -n "$line" ]; do
    # 去首尾空白
    line=${line#"${line%%[![:space:]]*}"}
    line=${line%"${line##*[![:space:]]}"}
    [ -n "$line" ] || continue
    case "$line" in \#*) continue ;; esac
    # 空白压成单个空格（制表符、全角空格都算），免得产物里出现控制字符
    line=$(printf '%s' "$line" | tr -s '[:space:]' ' ')
    [ -n "$line" ] || continue
    printf '%s\n' "$line"
  done <"$tmp.lines"
} >"$tmp.lines2"

{
  printf '[\n'
  while IFS= read -r line; do
    # ⚠️ 截断必须按**字符**，不能按字节：日文与 emoji 会被切成半个 UTF-8 序列。
    # 这个脚本开头已把 locale 设成 UTF-8，所以 `${#line}` 与切片都是按字符的。
    if [ ${#line} -gt "$NAME_LIMIT" ]; then
      line=${line:0:$NAME_LIMIT}
    fi
    count=$((count + 1))
    [ $count -le $LIMIT ] || { echo "超过 $LIMIT 条，后面的忽略了" >&2; break; }
    [ $count -gt 1 ] && printf ',\n'
    printf '  "%s"' "$(printf '%s' "$line" | json_escape)"
  done <"$tmp.lines2"
  printf '\n]\n'
} >"$tmp"
rm -f "$tmp.lines" "$tmp.lines2"

# 一条都没有：这是**明确的清空指令**（文件在，但里面没有有效行）。
#
# ⚠️ 不能和「文件不存在」混为一谈：那个分支保留上一份产物，这个分支要真的清空。
# 客户端见到空数组会怎么处理见 `sponsors.rs` —— 它把「远端明确给了空」当成
# 正当结果并清掉缓存，而不是当成取不到回落旧数据。
[ "$count" -gt 0 ] || echo "名单文件是空的，按「清空」处理"

# 上线前的最后一道闸。
#
# ⚠️ 只查 `json.load` 不够：JSON 解析器按字节透传字符串，**非法 UTF-8 也能解析成功**
# （实测一个孤立的 UTF-8 起始字节能让 `JSON.parse` 与 `json.load` 都通过）。
# 必须再用严格模式解一次码，否则坏字节会一路发到客户端才在 serde 那里炸。
if command -v python3 >/dev/null 2>&1; then
  python3 - "$tmp" <<'PYEOF' || { echo "生成的 JSON 不合法，拒绝上线：$tmp" >&2; exit 1; }
import json, sys
raw = open(sys.argv[1], 'rb').read()
raw.decode('utf-8')            # 严格解码，坏字节在这里抛
json.loads(raw.decode('utf-8'))
PYEOF
fi

mv -f "$tmp" "$OUT"
trap - EXIT
chmod 644 "$OUT"
echo "已更新 $OUT（$count 条）"
