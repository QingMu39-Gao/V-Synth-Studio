#!/bin/bash
# 两个生成器的回归测试：造临时目录 → 跑脚本 → 用客户端同款判据核对产物。
#
#     bash deploy/server/test.sh
#
# 为什么要它：「丢文件就生效」这条路的失败几乎都是**静默**的 —— 少一个平台键、sha256 带了
# 转义前缀、公告正文被吃掉，都不报错，只是客户端那边少了东西或校验失败。这些都在下面钉住。
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
FAILED=0

ok()   { echo "  ok   $1"; }
bad()  { echo "  FAIL $1"; FAILED=1; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3]，实际 [$2]）"; fi }

mkdir -p "$WORK/dl" "$WORK/announce" "$WORK/api"

# 造包：两个 windows 版本（应选高的）、macos、linux、一个无关文件、一个版本段抠不出来的
printf 'A%.0s' {1..1000} >"$WORK/dl/v-synth-studio_1.4.2_x64-setup.exe"
printf 'B%.0s' {1..500}  >"$WORK/dl/v-synth-studio_1.3.0_x64-setup.exe"
printf 'C%.0s' {1..700}  >"$WORK/dl/v-synth-studio_1.4.2beta_aarch64.dmg"
printf 'D%.0s' {1..300}  >"$WORK/dl/v-synth-studio_1.4.2_amd64.deb"
printf 'E%.0s' {1..900}  >"$WORK/dl/v-synth-studio_1.4.10_x64-setup.exe"
echo 'ignore me'          >"$WORK/dl/random.txt"
echo 'x'                  >"$WORK/dl/v-synth-studio_bad_name.exe"

echo "version.json"

export VSS_DL_DIR="$WORK/dl" VSS_API_DIR="$WORK/api" VSS_URL_BASE='https://t.example/dl'
# 公告那一段也要这个：漏了就会去读默认的 /var/www/vss/announce，
# 表现是「本机跑测试永远失败」而服务器上反而正常（那里目录真的存在）。
export VSS_ANNOUNCE_DIR="$WORK/announce"
if bash "$HERE/gen-version-json.sh" >/dev/null 2>&1; then ok "生成成功"; else bad "生成失败"; fi
V="$WORK/api/version.json"

grep -q '"version": "1.4.10"' "$V" && ok "顶层取最高版本（1.4.10 > 1.4.2）" \
  || bad "顶层版本不对：$(grep '"version"' "$V")"
grep -q 'v-synth-studio_1.4.10_x64-setup.exe' "$V" && ok "windows 取最高版本" \
  || bad "windows 没取到最高版本"
grep -q 'v-synth-studio_1.4.2beta_aarch64.dmg' "$V" && ok "macos 识别 dmg" || bad "macos 缺失"
grep -q 'v-synth-studio_1.4.2_amd64.deb' "$V" && ok "linux 识别 deb" || bad "linux 缺失"
grep -q 'random.txt' "$V" && bad "无关文件被写进去了" || ok "无关文件被跳过"
grep -q 'bad_name' "$V" && bad "版本段抠不出的文件被写进去了" || ok "非法文件名被跳过"

# sha256 必须是裸的 64 位小写十六进制：`sha256sum` 在特殊文件名下会给整行加 `\` 前缀，
# 客户端（ipc/update.rs）按长度与字符集判，带前缀就整条被当成「没给摘要」。
if grep -o '"sha256": "[^"]*"' "$V" | sed 's/.*: "//; s/"//' |
     grep -qvE '^[0-9a-f]{64}$'; then
  bad "sha256 不是裸的 64 位小写十六进制"
else
  ok "sha256 格式合法"
fi

# size 必须与盘上真实字节数一致（对不上客户端下完就判失败）
want=$(stat -c%s "$WORK/dl/v-synth-studio_1.4.10_x64-setup.exe" 2>/dev/null ||
       stat -f%z "$WORK/dl/v-synth-studio_1.4.10_x64-setup.exe")
grep -q "\"size\": $want" "$V" && ok "size 与文件一致" || bad "size 与文件不一致（应为 $want）"
grep -q '"min_version": "1.0.0"' "$V" && grep -q '"force": false' "$V" \
  && ok "min_version / force 是常量" || bad "min_version / force 被改动了"

# 扫描与写 JSON 之间包被删：必须失败，且**绝不能**把坏 JSON 顶上线。
# 这一条对应真实事故：`"size": $(stat -c%s ...)` 里命令替换的失败不触发 `set -e`，
# 于是写出了 `"size": ,` —— 语法非法的 JSON 被原子替换上线，脚本还打印「已更新」。
# 用 PATH 注入一个必然失败的 `stat` 来复现（比真去抢时间窗可靠）。
mkdir -p "$WORK/race/dl" "$WORK/race/api"
printf 'Z%.0s' {1..100} >"$WORK/race/dl/v-synth-studio_2.0.0_x64-setup.exe"
if VSS_DL_DIR="$WORK/race/dl" VSS_API_DIR="$WORK/race/api" bash "$HERE/gen-version-json.sh" >/dev/null 2>&1; then
  ok "正常场景能写出"
else
  bad "正常场景写不出来"
fi
GOOD=$(cat "$WORK/race/api/version.json")
FAKEBIN="$WORK/race/fakebin" && mkdir -p "$FAKEBIN"
printf '#!/bin/bash\nexit 1\n' >"$FAKEBIN/stat" && chmod +x "$FAKEBIN/stat"
if PATH="$FAKEBIN:$PATH" VSS_DL_DIR="$WORK/race/dl" VSS_API_DIR="$WORK/race/api" \
     bash "$HERE/gen-version-json.sh" >/dev/null 2>&1; then
  bad "取不到 size 时应当失败"
else
  ok "取不到 size 时返回非 0"
fi
[ "$(cat "$WORK/race/api/version.json")" = "$GOOD" ] \
  && ok "失败时线上文件保持上一份完好内容" || bad "失败时线上文件被改坏了"
if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
  PY2=$(command -v python3 || command -v python)
  "$PY2" -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8'))" "$WORK/race/api/version.json" 2>/dev/null \
    && ok "残留产物仍是合法 JSON" || bad "残留产物不是合法 JSON"
fi
# 同一道闸也要挡住 sha256 取不到的情况
FAKEBIN2="$WORK/race/fakebin2" && mkdir -p "$FAKEBIN2"
printf '#!/bin/bash\nexit 1\n' >"$FAKEBIN2/sha256sum" && chmod +x "$FAKEBIN2/sha256sum"
if PATH="$FAKEBIN2:$PATH" VSS_DL_DIR="$WORK/race/dl" VSS_API_DIR="$WORK/race/api" \
     bash "$HERE/gen-version-json.sh" >/dev/null 2>&1; then
  bad "取不到 sha256 时应当失败"
else
  ok "取不到 sha256 时返回非 0"
fi
[ "$(cat "$WORK/race/api/version.json")" = "$GOOD" ] \
  && ok "sha256 失败时线上文件也没被改坏" || bad "sha256 失败时线上文件被改坏"

# 没有包时不是错误：写一份「无更新」的 JSON 并正常退出。
# `exit 1` 会让计划任务每分钟失败一次，宝塔里永远挂着一条红记录 ——
# 那种长期红点会让人开始忽略告警。`version` 用 `0.0.0`：客户端逐段比数字，
# 它比任何已发布版本都低，所以不会提示更新（`update.rs::is_newer` 的测试已覆盖这点）。
mkdir -p "$WORK/empty" && mkdir -p "$WORK/api2"
if VSS_DL_DIR="$WORK/empty" VSS_API_DIR="$WORK/api2" bash "$HERE/gen-version-json.sh" >/dev/null 2>&1; then
  ok "空目录正常退出（不是失败）"
else
  bad "空目录不该失败"
fi
grep -q '"version": "0.0.0"' "$WORK/api2/version.json" 2>/dev/null \
  && ok "空目录写出 version 0.0.0（客户端当无更新）" || bad "空目录的 version 不对"
grep -q '"downloads": {' "$WORK/api2/version.json" 2>/dev/null \
  && ok "空目录的 downloads 为空对象" || bad "空目录的 downloads 不对"

# changelog 从旁路文件读：JSON 每分钟重写，写进 JSON 的说明会被下一次覆盖抹掉
printf '修复了下载校验\n第二行说明\n' >"$WORK/changelog.txt"
export VSS_CHANGELOG_FILE="$WORK/changelog.txt"
bash "$HERE/gen-version-json.sh" >/dev/null 2>&1
grep -q '"changelog": "修复了下载校验\\n第二行说明"' "$WORK/api/version.json" \
  && ok "changelog 从旁路文件读入并转义" || bad "changelog 没读到：$(grep changelog "$WORK/api/version.json")"
# 文件不存在时必须是空串，而不是报错或缺字段
rm -f "$WORK/changelog.txt"
if bash "$HERE/gen-version-json.sh" >/dev/null 2>&1; then
  grep -q '"changelog": ""' "$WORK/api/version.json" \
    && ok "changelog 缺失时是空串" || bad "changelog 缺失时不是空串"
else
  bad "changelog 文件不存在时生成失败"
fi

echo "announcement.json"

# A 型：第一行标题，其余正文
printf '今晚维护\n23:00–24:00 期间无法登录。\n请提前保存工作。\n' \
  >"$WORK/announce/2026-10-17-maint.txt"
# B 型：元数据 + 正文，含需要转义的引号与反斜杠
# 反斜杠用单引号段拼进去：`printf` 会把 `\\` 当转义序列，写错就静默变成退格符。
BACKSLASH='\'
printf 'title: 严重故障已修复\nlevel: critical\nexpires: 2026-12-31T00:00:00Z\nurl: https://e.example/s\n---\n下载节点已恢复。\n"带引号" 与 %s%s反斜杠。\n' \
  "$BACKSLASH" "$BACKSLASH" >"$WORK/announce/2026-10-16-critical.txt"
# 空文件：该被跳过
: >"$WORK/announce/2026-10-15-empty.txt"
# 带 UTF-8 BOM：Windows 上编辑过的 txt 几乎必然带它。BOM 留在标题首字符时，
# 界面上表现为标题前面多一个乱码方块。
printf '\xef\xbb\xbfBOM 标题\nBOM 正文\n' >"$WORK/announce/2026-10-14-bom.txt"

if bash "$HERE/gen-announcement-json.sh" >/dev/null 2>&1; then ok "生成成功"; else bad "生成失败"; fi
A="$WORK/api/announcement.json"
grep -q '2026-10-17-maint' "$A" && ok "A 型 id 取文件名" || bad "A 型缺失"
grep -q '23:00–24:00 期间无法登录。\\n请提前保存工作。' "$A" && ok "A 型正文完整（不是空）" \
  || bad "A 型正文丢了"
grep -q '"title": "今晚维护"' "$A" && ok "A 型第一行当标题" || bad "A 型标题不对"
grep -q '2026-10-15-empty' "$A" && bad "空文件被写进去了" || ok "空文件被跳过"
grep -q '"level": "critical"' "$A" && ok "B 型 level 透传" || bad "B 型 level 不对"
grep -q '\\"带引号\\"' "$A" && ok "双引号被转义" || bad "双引号没转义"
grep -q '\\\\反斜杠' "$A" && ok "反斜杠被转义" || bad "反斜杠没转义"
grep -q '"expires_at": "2026-12-31T00:00:00Z"' "$A" && ok "expires 透传" || bad "expires 缺失"
# BOM 必须被剥掉：留在标题里就是一个乱码字符，而它不会让 JSON 非法，所以只能这样钉
grep -q '"title": "BOM 标题"' "$A" && ok "BOM 被剥掉" || bad "BOM 混进了标题"

# 产物必须是合法 JSON，且是数组（客户端 items_from 认数组那条分支）
if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
  PY=$(command -v python3 || command -v python)
  # encoding 必须显式给：Windows 上 `open()` 默认按 GBK 解码，UTF-8 的正文字节会直接抛
  # UnicodeDecodeError —— 那是测试脚本的错，不是产物的错。
  for f in "$V" "$A"; do
    if "$PY" -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8'))" "$f" 2>/dev/null; then
      ok "$(basename "$f") 是合法 JSON"
    else
      bad "$(basename "$f") 不是合法 JSON"
    fi
  done
  "$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); sys.exit(0 if isinstance(d,list) else 1)" "$A" \
    && ok "announcement.json 是数组" || bad "announcement.json 不是数组"
fi

echo
echo "sponsors.json"
S="$WORK/api/sponsors.json"
mkdir -p "$WORK/sp"
# 形如真实维护的名单：带 BOM、注释、空行、首尾空格、制表符、日文、emoji
printf '\xEF\xBB\xBF坎伊bbb\nDesire Control\n\n# 这一行是注释，不该出现\n  浅唱教主  \nゆりかごから墓場まで\n星街彗星🎤\n带\t制表符\n' >"$WORK/sp/sponsors.txt"
VSS_SPONSOR_FILE="$WORK/sp/sponsors.txt" VSS_API_DIR="$WORK/api" bash "$HERE/gen-sponsors-json.sh" >/dev/null 2>&1 \
  && ok "生成成功" || bad "生成失败"
# ⚠️ 数「命中行数」要用 `grep -c` 的**输出**，别写成 `grep -c ... || echo 0`：
# 它在没命中时会既打印 0 又因为退出码非 0 再走一遍 `echo 0`，结果是两行。
count_of() { local n; n=$(grep -c "$1" "$S" 2>/dev/null); echo "${n:-0}"; }
check "注释被跳过" "$(count_of '这一行是注释')" "0"
check "首尾空格被去掉" "$(count_of '  浅唱教主')" "0"
check "制表符被压成空格" "$(count_of '"带 制表符"')" "1"
# BOM 留在第一个 ID 前面就是一个乱码字符，而它不会让 JSON 非法，只能这样钉
check "BOM 被剥掉" "$(count_of '"坎伊bbb"')" "1"
# 日文与 emoji 必须原样保住：按字节截断会把它们切成半个 UTF-8 序列。
# ⚠️ 不用 `grep '星街彗星🎤'` 比对：这个字面量要穿过 shell 与文件编码两层，
# 弄坏的是测试本身而不是产物（实测文件里 4 字节序列是好的）。
# 这里直接问 Python：第 5 个元素是不是以那三个汉字开头、末尾是不是那个 emoji。
check "日文原样保住" "$(count_of 'ゆりかごから墓場まで')" "1"
if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
  PY3=$(command -v python3 || command -v python)
  "$PY3" - "$S" <<'PYEOF'
import json, sys
names = json.load(open(sys.argv[1], encoding='utf-8'))
target = [n for n in names if n.startswith('\u661f\u8857\u5f57\u661f')]
ok = len(target) == 1 and target[0] == '\u661f\u8857\u5f57\u661f\U0001F3A4'
sys.exit(0 if ok else 1)
PYEOF
  [ $? -eq 0 ] && ok "emoji 原样保住" || bad "emoji 被改坏了"
fi
if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
  PY2=$(command -v python3 || command -v python)
  "$PY2" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); sys.exit(0 if isinstance(d,list) and len(d)==6 else 1)" "$S" 2>/dev/null \
    && ok "是合法数组且条数正确（6）" || bad "不是合法数组或条数不对"
fi
# 名单文件不存在时不写产物：文件不在不是指令，保留上一份才是对的。
# （写成 `[]` 会让客户端当成「名单空了」，把用户已有的名单抹掉。）
printf '[\n  "旧名单"\n]\n' >"$S"
VSS_SPONSOR_FILE="$WORK/sp/nope.txt" VSS_API_DIR="$WORK/api" bash "$HERE/gen-sponsors-json.sh" >/dev/null 2>&1 \
  && ok "没有名单文件时正常退出" || bad "没有名单文件时失败了"
check "没有名单文件时保留上一份产物" "$(count_of '旧名单')" "1"

# 文件存在但没有任何有效行：这是**明确的清空**，要真的写空数组
: >"$WORK/sp/empty.txt"
VSS_SPONSOR_FILE="$WORK/sp/empty.txt" VSS_API_DIR="$WORK/api" bash "$HERE/gen-sponsors-json.sh" >/dev/null 2>&1 \
  && ok "空名单文件时正常退出" || bad "空名单文件时失败了"
check "空名单文件写成空数组" "$(tr -d ' \n' <"$S")" "[]"

# ⚠️ 超长日文名：`${#line}` 在 C locale 下按字节数，会把字符切在中间，
# 产出一个孤立的 UTF-8 起始字节。JSON 解析器按字节透传，**照样解析成功**，
# 所以只查 json.load 的闸拦不住 —— 必须用严格解码。脚本开头已固定 locale。
printf 'A%.0s' {1..59} >"$WORK/sp/long.txt"
printf 'あいうえお\n' >>"$WORK/sp/long.txt"
VSS_SPONSOR_FILE="$WORK/sp/long.txt" VSS_API_DIR="$WORK/api" \
  LC_ALL=C LANG=C bash "$HERE/gen-sponsors-json.sh" >/dev/null 2>&1 \
  && ok "超长日文名（外层 C locale）生成成功" || bad "超长日文名生成失败"
# 严格 UTF-8 检查：优先 python3（服务器上一定有），本地没有就用 node。
# ⚠️ 这两个都不在时**必须报 FAIL**，不能静默跳过 —— 跳过会让这条最关键的
# 断言在本地永远显示「通过」，而它偏偏是唯一能抓住半个字符的那条。
utf8_strict_ok() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PYEOF'
import sys
try:
    open(sys.argv[1], 'rb').read().decode('utf-8')
    sys.exit(0)
except UnicodeDecodeError:
    sys.exit(1)
PYEOF
  elif command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs");try{new TextDecoder("utf-8",{fatal:true}).decode(fs.readFileSync(process.argv[1]));process.exit(0)}catch(e){process.exit(1)}' "$1"
  else
    return 2
  fi
}
utf8_strict_ok "$S"
case $? in
  0) ok "产物是严格合法的 UTF-8" ;;
  2) bad "没有 python3 / node，无法检查严格 UTF-8（不能跳过）" ;;
  *) bad "产物里有半个字符（被按字节截断了）" ;;
esac

echo
if [ "$FAILED" -eq 0 ]; then echo "全部通过"; else echo "有失败项"; fi
exit "$FAILED"
