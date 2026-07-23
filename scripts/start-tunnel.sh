#!/usr/bin/env bash
# 云电脑本地对接脚本：起 cloudflared，把 im-bot.jaykwok.net 经 Cloudflare 隧道接到本机 :1011。
#
# 前置：
#   1) 机器人已在本机 :1011 跑起来（./deploy.sh 选 Cloudflare 模式）
#   2) 隧道 token 已放到 data/tunnel-token（从服务器 /root/.cpa-bot-tunnel-token.env 拷过来）
#      或导出环境变量 TUNNEL_TOKEN
#
# 用法： ./scripts/start-tunnel.sh
set -euo pipefail

BOT_PORT="${BOT_PORT:-1011}"
TOKEN_FILE="data/tunnel-token"

# ---- 1. 取 token ----
if [ -z "${TUNNEL_TOKEN:-}" ]; then
    if [ -f "$TOKEN_FILE" ]; then
        TUNNEL_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
    else
        echo "✗ 未找到隧道 token。" >&2
        echo "  把服务器 /root/.cpa-bot-tunnel-token.env 里的 TUNNEL_TOKEN 值写入 $TOKEN_FILE，" >&2
        echo "  或： export TUNNEL_TOKEN=<...>" >&2
        exit 1
    fi
fi

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
    echo "⚠ 本机 :${BOT_PORT} 无响应——先 ./deploy.sh 把机器人起来（Cloudflare 模式）" >&2
fi

# ---- 4. 起隧道（前台）----
echo "▶ 启动 cloudflared：im-bot.jaykwok.net  <==>  localhost:${BOT_PORT}"
echo "  （前台运行，Ctrl+C 停止。常驻开机自启可用 systemd/tmux 包一层）"
exec cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN"
