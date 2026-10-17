#!/bin/bash
# 装一次：把两个生成器放到服务器上，并配好它们要的两个目录。
#
#     sudo bash deploy/server/install.sh
#
# 幂等：重复跑只会覆盖脚本、补齐缺的目录，不会删任何已发布的包或公告。
#
# ⚠️ 这个脚本**不建计划任务**，也不改 nginx。那两件事在 如何编译打包.md 第六节，
# 因为它们各自的失败方式不同（计划任务跑不起来是静默的；nginx 改错是 502），
# 合进安装脚本里出错时不好定位。
set -euo pipefail

BIN=/www/release/bin
DL=/var/www/vss/dl
ANNOUNCE=/var/www/vss/announce
API=/var/www/vss/api
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

[ "$(id -u)" -eq 0 ] || { echo "要用 root 跑（写 /var/www 与 /www）" >&2; exit 1; }

install -d -m 755 "$BIN" "$DL" "$ANNOUNCE" "$API"

# 源目录 == 目标目录时跳过拷贝：`install` 遇到同文件会报 "are the same file" 并退出，
# 那样「已经在 /www/release/bin 里再装一次」会静默失败（宝塔里只留一行日志）。
if [ "$(cd "$HERE" && pwd -P)" != "$(cd "$BIN" && pwd -P)" ]; then
  install -m 755 "$HERE/gen-version-json.sh" "$BIN/gen-version-json.sh"
  install -m 755 "$HERE/gen-announcement-json.sh" "$BIN/gen-announcement-json.sh"
  install -m 644 "$HERE/lib.sh" "$BIN/lib.sh"
else
  echo "源目录就是 $BIN，跳过拷贝（只补目录与权限）"
fi

# nginx worker 以 www 跑：这两个目录是要被它读的，必须让 others 有读位。
# 生成器产出 644，所以这里只保证目录与已有文件的权限不被收紧。
chmod 755 "$DL" "$ANNOUNCE" "$API"
find "$DL" "$ANNOUNCE" -maxdepth 1 -type f -exec chmod 644 {} +

echo "已安装："
echo "  $BIN/gen-version-json.sh"
echo "  $BIN/gen-announcement-json.sh"
echo
echo "接着手动做两件事（见 如何编译打包.md 第六节）："
echo "  1. 宝塔 → 计划任务 → Shell 脚本，每 1 分钟跑这两个脚本；"
echo "  2. 确认 nginx 的 location /dl/ 是长缓存而不是 no-store。"
