#!/usr/bin/env bash
# 云电脑本地对接脚本：起 cloudflared，把 im-bot.jaykwok.net 经 Cloudflare 隧道接到本机 BOT_PORT（默认 1011）。
#
# 前置：
#   1) 机器人已在本机 BOT_PORT 跑起来（./scripts/deploy.sh 选 Cloudflare 模式）
#   2) 隧道 token。来源（按优先级）：
#        位置参数：./scripts/start-tunnel.sh <token-file>   # 路径，相对或绝对
#        环境变量：TUNNEL_TOKEN_FILE=<path>                 # 指定文件
#        环境变量：TUNNEL_TOKEN=<raw-token>                 # 直接给值
#        默认：    data/tunnel-token                        # raw 值或 .env 形式均可
#      token 文件可以是 raw token，也可以是直接拷来的 .env
#      （如服务器 .cpa-bot-tunnel-token.env，内含 TUNNEL_TOKEN=<value>）。
#
# 用法： ./scripts/start-tunnel.sh [token-file]
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if [ -n "${BOT_PORT:-}" ]; then
    BOT_PORT="$BOT_PORT"
elif [ -f data/bot-port ]; then
    BOT_PORT="$(tr -d '[:space:]' < data/bot-port)"
else
    BOT_PORT="1011"
fi
if ! [[ "$BOT_PORT" =~ ^[0-9]+$ ]] || [ "$BOT_PORT" -lt 1 ] || [ "$BOT_PORT" -gt 65535 ]; then
    echo "✗ BOT_PORT 必须是 1–65535 的整数" >&2
    exit 1
fi

# 从 .env 形式文件取 TUNNEL_TOKEN 的值（取等号后整段）；非 .env 则退出 7。
extract_env_token() {
    awk '
        /^[[:space:]]*TUNNEL_TOKEN[[:space:]]*=/ { sub(/^[^=]*=/, ""); print; found=1; exit }
        END { exit (found ? 0 : 7) }
    ' "$1"
}

# ---- 1. 取 token（位置参数 > TUNNEL_TOKEN_FILE > TUNNEL_TOKEN > 默认文件）----
if [ "$#" -ge 1 ] && [ -n "$1" ]; then
    TOKEN_FILE="$1"
elif [ -n "${TUNNEL_TOKEN_FILE:-}" ]; then
    TOKEN_FILE="$TUNNEL_TOKEN_FILE"
elif [ -n "${TUNNEL_TOKEN:-}" ]; then
    TOKEN_FILE=""
    echo "ℹ 使用环境变量 TUNNEL_TOKEN"
else
    TOKEN_FILE="data/tunnel-token"
fi

if [ -n "$TOKEN_FILE" ]; then
    if [ ! -f "$TOKEN_FILE" ]; then
        echo "✗ 未找到隧道 token 文件：$TOKEN_FILE" >&2
        echo "  优先级：位置参数 > TUNNEL_TOKEN_FILE > TUNNEL_TOKEN > data/tunnel-token" >&2
        exit 1
    fi
    if val="$(extract_env_token "$TOKEN_FILE")" && [ -n "$val" ]; then
        TUNNEL_TOKEN="$val"
    else
        TUNNEL_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
    fi
    echo "ℹ token 来自文件：$(cd "$(dirname "$TOKEN_FILE")" && pwd)/$(basename "$TOKEN_FILE")"
fi

# 统一清洗：只保留 base64 字符（去空白/引号/BOM/CR）
TUNNEL_TOKEN="$(printf '%s' "$TUNNEL_TOKEN" | tr -cd 'A-Za-z0-9+/=_-')"
[ -n "$TUNNEL_TOKEN" ] || { echo "✗ token 清洗后为空" >&2; exit 1; }

# ---- 2. 确保 cloudflared ----
if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared 未安装，尝试安装（Linux）..."
    if [ "$(uname -s)" = "Linux" ] && command -v curl >/dev/null 2>&1; then
        ARCH=$(uname -m)
        case "$ARCH" in
            x86_64)       BIN=cloudflared-linux-amd64;;
            aarch64|arm64) BIN=cloudflared-linux-arm64;;
            *) echo "✗ 不支持的架构 $ARCH，请手动安装 cloudflared" >&2; exit 1;;
        esac
        sudo curl -fsSL -o /usr/local/bin/cloudflared \
            "https://github.com/cloudflare/cloudflared/releases/latest/download/$BIN"
        sudo chmod +x /usr/local/bin/cloudflared
    else
        echo "✗ 请先安装 cloudflared：" >&2
        echo "  Linux:   https://pkg.cloudflare.com/cloudflared 或下载二进制到 /usr/local/bin" >&2
        echo "  macOS:   brew install cloudflared" >&2
        echo "  Windows: https://github.com/cloudflare/cloudflared/releases (cloudflared-windows-amd64.exe)" >&2
        exit 1
    fi
fi

# ---- 3. 探测本机机器人 ----
if curl -fsS "http://localhost:${BOT_PORT}/favicon.svg" >/dev/null 2>&1; then
    echo "✓ 本机 :${BOT_PORT} 机器人在线"
else
    echo "⚠ 本机 :${BOT_PORT} 无响应——先 ./scripts/deploy.sh 把机器人起来（Cloudflare 模式）" >&2
fi

# ---- 4. 起隧道（前台）----
echo "▶ 启动 cloudflared connector（控制台 Published application 应配置为 http://localhost:${BOT_PORT}）"
echo "  （前台运行，Ctrl+C 停止。常驻开机自启可用 systemd/tmux 包一层）"
exec cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN"
