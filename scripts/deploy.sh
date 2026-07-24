#!/bin/bash

# 量子密信群聊协作机器人部署脚本 (Debian + Docker, Bun)
# AI 配置（provider/key/model）由 data/models.json 承载，容器内 TUI 生成；
# 无必需 .env/config.json。访问控制由应用 secret + 网络层（直连=UFW / Cloudflare=WAF）共同承担。
# 两种部署模式：直连（公网 IP + UFW 限平台 IP）/ Cloudflare（cloudflared 隧道 + WAF）。

set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# 量子密信平台出口 IP（webhook 来源；UFW/WAF 按此放行）。变更可在此改或用环境变量覆盖。
PLATFORM_IP="${PLATFORM_IP:-223.244.14.237}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_status() { echo -e "${BLUE}[*] $1${NC}"; }
print_success() { echo -e "${GREEN}[+] $1${NC}"; }
print_warning() { echo -e "${YELLOW}[!] $1${NC}"; }
print_error() { echo -e "${RED}[-] $1${NC}"; }
print_prompt() { echo -e "${CYAN}?> $1${NC}"; }

# ---- 前置检查 ----

print_status "检查运行环境..."

if ! docker info > /dev/null 2>&1; then
    print_error "无法连接 Docker，请确保 Docker 已安装且当前用户有权限"
    echo "  提示: sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
fi

required_files=("package.json" "src/server/index.ts" "scripts/configure.ts")
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        print_error "缺少必要文件: $file"
        exit 1
    fi
done

print_success "环境检查通过"

# ---- 目录 + 监听端口 ----

mkdir -p logs data
if [ -n "${BOT_PORT:-}" ]; then
    PORT_DEFAULT="$BOT_PORT"
elif [ -f data/bot-port ]; then
    PORT_DEFAULT="$(tr -d '[:space:]' < data/bot-port)"
else
    PORT_DEFAULT="1011"
fi
print_prompt "机器人监听端口 [默认 ${PORT_DEFAULT}]:"
read -r port_in
BOT_PORT="${port_in:-$PORT_DEFAULT}"
if ! [[ "$BOT_PORT" =~ ^[0-9]+$ ]] || [ "$BOT_PORT" -lt 1 ] || [ "$BOT_PORT" -gt 65535 ]; then
    print_error "端口必须是 1–65535 的整数"
    exit 1
fi
printf '%s' "$BOT_PORT" > data/bot-port
print_success "监听端口：$BOT_PORT"

# ---- 部署模式 ----

echo ""
print_prompt "选择部署模式："
echo "  1) 直连模式 — 服务器有公网 IP，直接暴露 :${BOT_PORT}（UFW 只放行平台 IP）"
echo "  2) Cloudflare 模式 — 经 cloudflared 隧道 + WAF（无公网 IP / 想要边缘防护）"
print_prompt "输入 1 或 2 [默认 1]:"
read -r mode_choice
case "$mode_choice" in
    2) DEPLOY_MODE="cloudflare" ;;
    *) DEPLOY_MODE="direct" ;;
esac
printf '%s' "$DEPLOY_MODE" > data/deploy-mode
if [ "$DEPLOY_MODE" = "cloudflare" ]; then
    BOT_HOST="127.0.0.1"
else
    BOT_HOST="0.0.0.0"
fi
print_status "部署模式：$DEPLOY_MODE"
if [ "$DEPLOY_MODE" = "direct" ]; then
    if command -v ufw >/dev/null 2>&1; then
        print_status "同步 UFW 规则到端口 ${BOT_PORT}..."
        sudo ufw allow from "$PLATFORM_IP" to any port "$BOT_PORT" proto tcp comment 'Mixin-Chatbot (平台IP)'
        if sudo ufw status | grep -q "Status: active"; then
            print_success "UFW 仅允许 ${PLATFORM_IP} 访问 TCP ${BOT_PORT}"
        else
            print_warning "UFW 规则已写入但尚未启用；请运行 scripts/setup-server.sh 或 sudo ufw enable"
        fi
    else
        print_warning "未安装 UFW；请在云防火墙/系统防火墙中仅允许 ${PLATFORM_IP} 访问 TCP ${BOT_PORT}"
    fi
else
    print_warning "请把 Cloudflare Tunnel 的 Published application 服务地址设为 http://localhost:${BOT_PORT}"
fi

# ---- Pi 用户目录总根（<phone>/tmp + <phone>/sessions）----
AGENT_CWD="${AGENT_CWD:-data}"
print_prompt "Pi 用户目录总根（默认 data = 容器内 /app/data）："
read -r cwd_in
[ -n "$cwd_in" ] && AGENT_CWD="$cwd_in"
CWD_ARGS=()
if [ "$AGENT_CWD" = "data" ]; then
    CWD_ENV_VAL="data"
else
    mkdir -p "$AGENT_CWD"
    HOST_AGENT_CWD="$(realpath "$AGENT_CWD")"
    if [ "$HOST_AGENT_CWD" = "/" ] || [ "$HOST_AGENT_CWD" = "$PROJECT_DIR" ]; then
        print_error "用户目录总根不能是文件系统根目录或项目根目录：$HOST_AGENT_CWD"
        exit 1
    fi
    chown 1001:1001 "$HOST_AGENT_CWD" 2>/dev/null || true
    chmod 755 "$HOST_AGENT_CWD"
    CWD_ARGS+=(-v "$HOST_AGENT_CWD:/app/workspace")
    CWD_ENV_VAL="/app/workspace"
    print_warning "主机目录挂到容器 /app/workspace（agent 在此读写/执行）"
fi
print_status "Pi 用户目录总根：$AGENT_CWD（容器内：$CWD_ENV_VAL）"
echo ""

# ---- 目录 ----

print_status "设置目录权限..."
# data/logs 需要容器内 appuser(1001) 可写（默认用户根、models.json、日志）
chown -R 1001:1001 data logs 2>/dev/null || true
chmod 755 data logs
print_success "目录就绪"

# ---- 停止旧容器 ----

print_status "停止现有容器..."
if docker ps -a --format '{{.Names}}' | grep -q '^mixin-chatbot$'; then
    docker stop mixin-chatbot 2>/dev/null || true
    docker rm mixin-chatbot 2>/dev/null || true
    print_success "旧容器已清理"
else
    print_success "没有发现旧容器"
fi

# ---- 构建镜像 ----

print_status "构建 Docker 镜像..."
if docker build -t mixin-chatbot .; then
    print_success "镜像构建成功"
else
    print_error "镜像构建失败"
    exit 1
fi

# ---- AI 配置（容器内 TUI 写 data/models.json）----
# 首次必须配置；已存在则询问是否重配。

if [ ! -f "data/models.json" ]; then
    print_status "首次配置 AI（provider/key/model）..."
    docker run --rm -it -v "$(pwd)/data:/app/data" mixin-chatbot bun run scripts/configure.ts
    if [ ! -f "data/models.json" ]; then
        print_error "未生成 data/models.json，已中止"
        exit 1
    fi
else
    print_status "检测到已有 data/models.json"
    print_prompt "重新配置 AI (provider/key/model)? [y/N]:"
    read -r reconf
    if [[ "$reconf" =~ ^[Yy]$ ]]; then
        docker run --rm -it -v "$(pwd)/data:/app/data" mixin-chatbot bun run scripts/configure.ts
    fi
fi
chown 1001:1001 data/models.json 2>/dev/null || true
chmod 600 data/models.json

# ---- Webhook 随机密钥路径（两模式共用，应用层鉴权）----
# data/webhook-secret 存 64hex（256bit）；应用启动读它，存在则启用 /webhook/<secret>。
if [ ! -f "data/webhook-secret" ]; then
    print_status "生成 webhook 随机密钥路径..."
    if SECRET=$(openssl rand -hex 32 2>/dev/null) && [ -n "$SECRET" ]; then
        : # openssl 可用
    else
        SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n') # 回退
    fi
    printf '%s' "$SECRET" > data/webhook-secret
    chown 1001:1001 data/webhook-secret 2>/dev/null || true
    chmod 600 data/webhook-secret
    print_success "已生成 webhook 密钥"
    SHOW_SECRET=1
else
    SECRET="$(tr -d '[:space:]' < data/webhook-secret)"
    if ! [[ "$SECRET" =~ ^[0-9a-fA-F]{32,64}$ ]]; then
        print_error "data/webhook-secret 格式无效（应为 32–64 位十六进制）；请删除该文件后重新部署以生成新密钥"
        exit 1
    fi
    SHOW_SECRET=0
    print_status "检测到已有 data/webhook-secret（沿用）"
fi

SERVER_IP=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "<服务器IP>")

echo ""
print_prompt "把回调地址填到 IM 平台（webhook URL）："
if [ "$DEPLOY_MODE" = "direct" ]; then
    if [ "$SHOW_SECRET" = "1" ]; then
        echo "    http://${SERVER_IP}:${BOT_PORT}/webhook/$SECRET"
    else
        echo "    http://${SERVER_IP}:${BOT_PORT}/webhook/<secret>（密钥未变；忘记可 cat data/webhook-secret）"
    fi
    echo ""
    print_warning "直连走 HTTP：secret 在 URL 里明文经「平台→服务器」传输，但 UFW 只放行 ${PLATFORM_IP}，仅平台流量可达"
    print_warning "确认 UFW：sudo ufw status（应为 allow from ${PLATFORM_IP} to any port ${BOT_PORT}）"
    print_warning "有域名想加密可自行套 nginx/caddy + 证书反代到 :${BOT_PORT}（URL 改 https://<域名>/webhook/<secret>）"
else
    if [ "$SHOW_SECRET" = "1" ]; then
        echo "    https://<你的域名>/webhook/$SECRET"
    else
        echo "    https://<你的域名>/webhook/<secret>（密钥未变；忘记可 cat data/webhook-secret）"
    fi
    echo ""
    print_warning "Cloudflare 模式仅监听 127.0.0.1:${BOT_PORT}，不会直接暴露公网端口"
    print_warning "部署末尾会启动 cloudflared connector；远程管理隧道的源站端口需在 Cloudflare 控制台配置为 http://localhost:${BOT_PORT}"
    print_warning "WAF 应只限制 /webhook/ 前缀：平台 IP + POST 放行，其他 webhook 请求 Block；可保留 /favicon.svg 供健康检查"
fi
if [ "$SHOW_SECRET" = "1" ]; then
    print_warning "密钥仅本次显示、不进容器日志；泄露时删 data/webhook-secret 重新部署即重新生成"
fi
echo ""

# ---- 启动容器 ----

print_status "启动容器..."
if docker run -d \
  --network host \
  -e AGENT_CWD="$CWD_ENV_VAL" \
  -e BOT_PORT="$BOT_PORT" \
  -e BOT_HOST="$BOT_HOST" \
  "${CWD_ARGS[@]}" \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  --stop-timeout 30 \
  --name mixin-chatbot \
  --memory="512m" \
  --memory-swap="768m" \
  --cpus="1.0" \
  --read-only \
  --tmpfs /tmp:size=10m \
  --tmpfs /app/.pi:size=10m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --log-driver json-file \
  --log-opt max-size=5m \
  --log-opt max-file=2 \
  mixin-chatbot; then
    print_success "容器启动成功"
else
    print_error "容器启动失败"
    docker logs mixin-chatbot 2>/dev/null
    exit 1
fi

# ---- 等待健康检查 ----

print_status "等待服务就绪..."
for i in $(seq 1 18); do
    status=$(docker inspect --format='{{.State.Health.Status}}' mixin-chatbot 2>/dev/null || echo "unknown")
    if [ "$status" = "healthy" ]; then
        print_success "健康检查通过"
        break
    fi
    if [ "$status" = "unhealthy" ]; then
        print_error "健康检查失败，请检查日志: docker logs mixin-chatbot"
        docker logs --tail 50 mixin-chatbot 2>&1 || true
        exit 1
    fi
    if [ $i -eq 18 ]; then
        print_error "健康检查超时（90s），请检查日志: docker logs mixin-chatbot"
        docker logs --tail 50 mixin-chatbot 2>&1 || true
        exit 1
    fi
    sleep 5
done

# ---- Cloudflare 模式：确保 cloudflared 在线 ----
if [ "$DEPLOY_MODE" = "cloudflare" ]; then
    print_status "Cloudflare 模式：确保 cloudflared 隧道在线..."
    if pgrep -x cloudflared >/dev/null 2>&1; then
        print_success "cloudflared 已在运行（pid $(pgrep -x cloudflared | head -n1)）"
    elif [ -x scripts/start-tunnel.sh ]; then
        print_warning "cloudflared 未运行，后台启动 start-tunnel.sh..."
        mkdir -p logs
        BOT_PORT="$BOT_PORT" nohup ./scripts/start-tunnel.sh >>"logs/cloudflared.log" 2>&1 &
        sleep 3
        if pgrep -x cloudflared >/dev/null 2>&1; then
            print_success "cloudflared 已后台启动（日志 logs/cloudflared.log）"
            print_warning "持久化建议：配 systemd 服务（开机自启 + 崩溃重启）；当前 nohup 仅本次运行"
        else
            print_error "cloudflared 未能启动；查 logs/cloudflared.log（可能缺 token：data/tunnel-token 或 TUNNEL_TOKEN）"
        fi
    else
        print_warning "未找到 scripts/start-tunnel.sh，跳过隧道；请手动起 cloudflared"
    fi
fi

# ---- 输出信息 ----

if docker ps --format '{{.Names}}' | grep -q '^mixin-chatbot$'; then
    print_success "服务启动成功"

    echo ""
    echo "=========================================="
    echo "  量子密信群聊协作机器人部署完成"
    echo "=========================================="
    echo ""
    if [ "$DEPLOY_MODE" = "direct" ]; then
        echo "  模式:      直连（UFW 限 ${PLATFORM_IP}）"
        echo "  Webhook:   http://${SERVER_IP}:${BOT_PORT}/webhook/<secret>"
    else
        echo "  模式:      Cloudflare（隧道 + WAF）"
        echo "  Webhook:   https://<你的域名>/webhook/<secret>"
    fi
    echo "  AI 配置:   $(pwd)/data/models.json"
    echo "  日志:      $(pwd)/logs/"
    echo "  数据:      $(pwd)/data/"
    echo "  用户目录:  $AGENT_CWD"
    echo "  监听:      $BOT_HOST:$BOT_PORT"
    echo ""
    echo "  内存限制: 512MB | CPU: 1核"
    echo ""
    echo "  常用命令:"
    echo "    docker logs -f mixin-chatbot                         # 实时日志"
    echo "    docker restart mixin-chatbot                         # 重启"
    echo "    docker run --rm -it -v \"\$(pwd)/data:/app/data\" mixin-chatbot bun run scripts/configure.ts && docker restart mixin-chatbot   # 重配 AI"
    echo ""

    print_status "最近日志:"
    docker logs --tail 10 mixin-chatbot 2>&1
else
    print_error "服务启动失败"
    docker logs mixin-chatbot 2>&1
    exit 1
fi
