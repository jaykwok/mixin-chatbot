#!/bin/bash

# 聊天机器人部署脚本 (Debian 13 + Docker)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() { echo -e "${BLUE}[*] $1${NC}"; }
print_success() { echo -e "${GREEN}[+] $1${NC}"; }
print_warning() { echo -e "${YELLOW}[!] $1${NC}"; }
print_error() { echo -e "${RED}[-] $1${NC}"; }

# ---- 前置检查 ----

print_status "检查运行环境..."

# 检查是否为 root 或有 docker 权限
if ! docker info > /dev/null 2>&1; then
    print_error "无法连接 Docker，请确保 Docker 已安装且当前用户有权限"
    echo "  提示: sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
fi

# 检查必要文件
required_files=(".env" "app.py" "requirements.txt")
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        print_error "缺少必要文件: $file"
        exit 1
    fi
done

# 检查 .env 是否配置了 API Key
if grep -q "your_api_key" .env 2>/dev/null; then
    print_error ".env 中的 DASHSCOPE_API_KEY 还是默认值，请先配置"
    exit 1
fi

print_success "环境检查通过"

# ---- 创建目录 ----

print_status "创建目录..."
mkdir -p logs data

# data/logs 目录需要容器内 appuser(1001) 可写
chown -R 1001:1001 data logs 2>/dev/null || true
chmod 755 data logs

print_success "目录就绪"

# ---- 停止旧容器 ----

print_status "停止现有容器..."
if docker ps -a --format '{{.Names}}' | grep -q '^chatbot$'; then
    docker stop chatbot 2>/dev/null || true
    docker rm chatbot 2>/dev/null || true
    print_success "旧容器已清理"
else
    print_success "没有发现旧容器"
fi

# ---- 构建镜像 ----

print_status "构建 Docker 镜像..."
if docker build -t chatbot .; then
    print_success "镜像构建成功"
else
    print_error "镜像构建失败"
    exit 1
fi

# 清理悬空镜像，回收磁盘空间
docker image prune -f 2>/dev/null && print_success "已清理悬空镜像"

# ---- 启动容器 ----

print_status "启动容器..."
if docker run -d \
  -p 1011:1011 \
  -v "$(pwd)/.env:/app/.env:ro" \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  --stop-timeout 30 \
  --name chatbot \
  --memory="400m" \
  --memory-swap="512m" \
  --cpus="1.0" \
  --read-only \
  --tmpfs /tmp:size=10m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --log-driver json-file \
  --log-opt max-size=5m \
  --log-opt max-file=2 \
  chatbot; then
    print_success "容器启动成功"
else
    print_error "容器启动失败"
    docker logs chatbot 2>/dev/null
    exit 1
fi

# ---- 等待健康检查 ----

print_status "等待服务就绪..."
# HEALTHCHECK: start-period=10s, interval=30s, retries=3
# 第一次有效检查在 ~40s，最多等 90s 覆盖所有 retries
for i in $(seq 1 18); do
    status=$(docker inspect --format='{{.State.Health.Status}}' chatbot 2>/dev/null || echo "unknown")
    if [ "$status" = "healthy" ]; then
        print_success "健康检查通过"
        break
    fi
    if [ "$status" = "unhealthy" ]; then
        print_error "健康检查失败，请检查日志: docker logs chatbot"
        break
    fi
    if [ $i -eq 18 ]; then
        print_warning "健康检查超时（90s），请检查日志: docker logs chatbot"
    fi
    sleep 5
done

# ---- 输出信息 ----

if docker ps --format '{{.Names}}' | grep -q '^chatbot$'; then
    print_success "服务启动成功"

    SERVER_IP=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "localhost")

    echo ""
    echo "=========================================="
    echo "  部署完成"
    echo "=========================================="
    echo ""
    echo "  Webhook:  http://${SERVER_IP}:1011/webhook"
    echo "  管理页面: http://${SERVER_IP}:1011/admin"
    echo "  配置文件: $(pwd)/.env"
    echo "  日志:     $(pwd)/logs/"
    echo "  数据:     $(pwd)/data/"
    echo ""
    echo "  内存限制: 400MB | CPU: 1核"
    echo ""
    echo "  常用命令:"
    echo "    docker logs -f chatbot     # 实时日志"
    echo "    docker restart chatbot     # 重启"
    echo "    docker stats chatbot       # 资源监控"
    echo ""

    print_status "最近日志:"
    docker logs --tail 10 chatbot 2>&1
else
    print_error "服务启动失败"
    docker logs chatbot 2>&1
    exit 1
fi
