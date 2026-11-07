#!/bin/bash
# macOS 入口：scripts/deploy.sh、ops.sh、upgrade.sh 在 Darwin 上把参数原样交给这里。系统自带的 bash 3.2 也能运行：只确认
# Apple 芯片并找到 Bun，其余（root、工具、服务账户、命令本身）由 ops/core/macos-entry.ts 负责。
# 用法：bash scripts/lib/macos-entry.sh <deploy|ops|upgrade> [参数...]
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1
fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$(/usr/bin/uname -m)" = arm64 ] || fail "macOS 只支持 Apple 芯片（arm64）"
[ "$(/usr/sbin/sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" != 1 ] || fail "终端运行在 Rosetta 转译下；请用原生（arm64）终端重试"
bun=""
for candidate in "${MIXIN_OPS_BUN:-}" "$(command -v bun 2>/dev/null)" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then bun="$candidate"; break; fi
done
[ -n "$bun" ] || fail "找不到 Bun。请用 Homebrew 安装：brew install oven-sh/bun/bun（服务账户也要能运行它，不要只装在个人目录里）"
exec "$bun" --no-env-file "$root/ops/core/macos-entry.ts" "$@"
