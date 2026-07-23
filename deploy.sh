#!/bin/bash

# 量子密信聊天机器人部署脚本 (Debian + Docker, Bun)
# 应用层零配置：AI 配置（provider/key/model）由 data/models.json 承载，容器内 TUI 生成；
# 访问控制交给服务器防火墙。无 .env、无 config.json。

set -e

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

required_files=("package.json" "src/index.ts" "scripts/configure.ts")
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        print_error "缺少必要文件: $file"
        exit 1
    fi
done

print_success "环境检查通过"

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

# ---- 启动容器 ----

print_status "启动容器..."
if docker run -d \
  -p 1011:1011 \
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

    SERVER_IP=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "localhost")

    echo ""
    echo "=========================================="
    echo "  量子密信聊天机器人部署完成"
    echo "=========================================="
    echo ""
    echo "  Webhook:   http://${SERVER_IP}:1011/webhook"
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
