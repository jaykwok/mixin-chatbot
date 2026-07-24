#!/bin/bash

# 量子密信群聊协作机器人部署脚本 (Debian + Docker, Bun)
# 应用层零配置：AI 配置（provider/key/model）由 data/models.json 承载，容器内 TUI 生成；
# 访问控制交给网络层（直连=UFW / Cloudflare=WAF）。无 .env、无 config.json。
# 两种部署模式：直连（公网 IP + UFW 限平台 IP）/ Cloudflare（cloudflared 隧道 + WAF）。

set -e

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

# ---- 部署模式 ----

echo ""
print_prompt "选择部署模式："
echo "  1) 直连模式 — 服务器有公网 IP，直接暴露 :1011（UFW 只放行平台 IP）"
echo "  2) Cloudflare 模式 — 经 cloudflared 隧道 + WAF（无公网 IP / 想要边缘防护）"
print_prompt "输入 1 或 2 [默认 1]:"
read -r mode_choice
case "$mode_choice" in
    2) DEPLOY_MODE="cloudflare" ;;
    *) DEPLOY_MODE="direct" ;;
esac
print_status "部署模式：$DEPLOY_MODE"

# ---- Pi agent 工作目录（read/bash/edit/write 根）----
AGENT_CWD="${AGENT_CWD:-data}"
print_prompt "Pi agent 工作目录（默认 data = 容器内 /app/data）："
read -r cwd_in
[ -n "$cwd_in" ] && AGENT_CWD="$cwd_in"
CWD_ARGS=()
if [ "$AGENT_CWD" = "data" ]; then
    CWD_ENV_VAL="data"
elif [[ "$AGENT_CWD" = /* ]]; then
    mkdir -p "$AGENT_CWD"
    chown -R 1001:1001 "$AGENT_CWD" 2>/dev/null || true
    chmod 755 "$AGENT_CWD"
    CWD_ARGS+=(-v "$AGENT_CWD:/app/workspace")
    CWD_ENV_VAL="/app/workspace"
    print_warning "绝对主机路径挂到容器 /app/workspace（agent 在此读写/执行）"
else
    mkdir -p "$AGENT_CWD"
    chown -R 1001:1001 "$AGENT_CWD" 2>/dev/null || true
    chmod 755 "$AGENT_CWD"
    CWD_ARGS+=(-v "$(pwd)/$AGENT_CWD:/app/$AGENT_CWD")
    CWD_ENV_VAL="$AGENT_CWD"
fi
print_status "Pi agent 工作目录：$AGENT_CWD（容器内：$CWD_ENV_VAL）"
echo ""

# ---- 目录 ----

print_status "创建目录..."
mkdir -p logs data
# data/logs 需要容器内 appuser(1001) 可写（会话、models.json、日志）
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

docker image prune -f 2>/dev/null && print_success "已清理悬空镜像"

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
    SECRET=$(cat data/webhook-secret 2>/dev/null || echo "")
    SHOW_SECRET=0
    print_status "检测到已有 data/webhook-secret（沿用）"
fi

SERVER_IP=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "<服务器IP>")

echo ""
print_prompt "把回调地址填到 IM 平台（webhook URL）："
if [ "$DEPLOY_MODE" = "direct" ]; then
    if [ "$SHOW_SECRET" = "1" ]; then
        echo "    http://${SERVER_IP}:1011/webhook/$SECRET"
    else
        echo "    http://${SERVER_IP}:1011/webhook/<secret>（密钥未变；忘记可 cat data/webhook-secret）"
    fi
    echo ""
    print_warning "直连走 HTTP：secret 在 URL 里明文经「平台→服务器」传输，但 UFW 只放行 ${PLATFORM_IP}，仅平台流量可达"
    print_warning "确认 UFW：sudo ufw status（应为 allow from ${PLATFORM_IP} to any port 1011；setup-server.sh 已配）"
    print_warning "有域名想加密可自行套 nginx/caddy + 证书反代到 :1011（URL 改 https://<域名>/webhook/<secret>）"
else
    if [ "$SHOW_SECRET" = "1" ]; then
        echo "    https://<你的域名>/webhook/$SECRET"
    else
        echo "    https://<你的域名>/webhook/<secret>（密钥未变；忘记可 cat data/webhook-secret）"
    fi
    echo ""
    print_warning "关闭公网 1011（cloudflared 本地连）：sudo ufw delete allow from ${PLATFORM_IP} to any port 1011 ; sudo ufw deny 1011/tcp"
    print_warning "还需：1) 装 cloudflared 起隧道指向 http://localhost:1011；2) Cloudflare WAF 放行 ip.src=${PLATFORM_IP} && POST && 路径 ^/webhook/[0-9a-f]{32,64}\$，其余 Block（详见 README 部署模式）"
fi
if [ "$SHOW_SECRET" = "1" ]; then
    print_warning "密钥仅本次显示、不进容器日志；泄露时删 data/webhook-secret 重新部署即重新生成"
fi
echo ""

# ---- 启动容器 ----

print_status "启动容器..."
if docker run -d \
  -p 1011:1011 \
  -e AGENT_CWD="$CWD_ENV_VAL" \
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
        break
    fi
    if [ $i -eq 18 ]; then
        print_warning "健康检查超时（90s），请检查日志: docker logs mixin-chatbot"
    fi
    sleep 5
done

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
        echo "  Webhook:   http://${SERVER_IP}:1011/webhook/<secret>"
    else
        echo "  模式:      Cloudflare（隧道 + WAF）"
        echo "  Webhook:   https://<你的域名>/webhook/<secret>"
    fi
    echo "  AI 配置:   $(pwd)/data/models.json"
    echo "  日志:      $(pwd)/logs/"
    echo "  数据:      $(pwd)/data/"
    echo ""
    echo "  内存限制: 512MB | CPU: 1核"
    echo ""
    echo "  常用命令:"
    echo "    docker logs -f mixin-chatbot                         # 实时日志"
    echo "    docker restart mixin-chatbot                         # 重启"
    echo "    docker run --rm -it -v \"\$(pwd)/data:/app/data\" mixin-chatbot bun run scripts/configure.ts   # 重配 AI"
    echo ""

    print_status "最近日志:"
    docker logs --tail 10 mixin-chatbot 2>&1
else
    print_error "服务启动失败"
    docker logs mixin-chatbot 2>&1
    exit 1
fi
