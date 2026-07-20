#!/bin/bash

# 量子密信聊天机器人部署脚本 (Debian 13 + Docker)

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

# 检查是否为 root 或有 docker 权限
if ! docker info > /dev/null 2>&1; then
    print_error "无法连接 Docker，请确保 Docker 已安装且当前用户有权限"
    echo "  提示: sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
fi

# 检查必要文件
required_files=("app.py" "requirements.txt")
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        print_error "缺少必要文件: $file"
        exit 1
    fi
done

print_success "环境检查通过"

# ---- 交互式生成 .env ----

setup_env() {
    if [ -f ".env" ]; then
        print_success ".env 已存在，跳过配置"
        # 仍校验是否为默认占位值
        if grep -q "your_api_key" .env 2>/dev/null; then
            print_error ".env 中的 DASHSCOPE_API_KEY 还是默认占位值，请手动编辑 .env 后重新运行"
            exit 1
        fi
        return 0
    fi

    echo ""
    echo "=========================================="
    echo "  首次部署配置 (.env)"
    echo "=========================================="
    echo "  请按提示输入各项配置，直接回车可使用 [默认值]"
    echo ""

    # --- DASHSCOPE_API_KEY ---
    while true; do
        print_prompt "请输入阿里云 DashScope API Key (必填，以 sk- 开头):"
        read -r api_key
        if [ -z "$api_key" ]; then
            print_error "API Key 不能为空，请重新输入"
            continue
        fi
        if [[ "$api_key" != sk-* ]]; then
            print_warning "API Key 通常以 sk- 开头，请确认输入是否正确"
            print_prompt "确认使用该 Key? [y/N]:"
            read -r confirm
            [[ "$confirm" =~ ^[Yy]$ ]] || continue
        fi
        break
    done

    # --- APP_USERNAME ---
    print_prompt "请输入管理页面用户名 [默认: admin]:"
    read -r username
    username=${username:-admin}

    # --- APP_PASSWORD ---
    while true; do
        print_prompt "请输入管理页面密码 (必填，建议 8 位以上，含大小写字母和数字):"
        read -rs password
        echo ""
        if [ -z "$password" ]; then
            print_error "密码不能为空，请重新输入"
            continue
        fi
        print_prompt "请再次输入密码确认:"
        read -rs password_confirm
        echo ""
        if [ "$password" != "$password_confirm" ]; then
            print_error "两次输入的密码不一致，请重新输入"
            continue
        fi
        break
    done

    # --- GROUP_CONFIGS ---
    echo ""
    print_status "群组模型配置 (可选): 为不同群组指定 AI 模型"
    print_status "格式: 群组ID:模型名，多个用逗号分隔"
    print_status "示例: 10086:qwen-plus,10010:kimi-k2.5"
    print_prompt "请输入群组配置 (可留空，稍后在 .env 中编辑):"
    read -r group_configs

    # --- AI_BASE_URL ---
    print_prompt "请输入 AI API 地址 [默认: 阿里云国内版]:"
    read -r ai_base_url
    ai_base_url=${ai_base_url:-https://dashscope.aliyuncs.com/compatible-mode/v1}

    # --- 生成 .env ---
    cat > .env << EOF
DASHSCOPE_API_KEY=$api_key
APP_USERNAME=$username
APP_PASSWORD=$password
GROUP_CONFIGS=$group_configs
AI_BASE_URL=$ai_base_url
EOF

    chmod 600 .env
    # 容器内 appuser(1001) 需要读取挂载进来的 .env，
    # volume 挂载无法在容器内改属主，故宿主机上把属主设为 1001、权限 640：
    # root 仍可读，appuser 可读，其他普通用户不可读
    chown 1001:1001 .env 2>/dev/null || true
    chmod 640 .env
    print_success ".env 配置文件已生成 (权限 640, 属主 1001)"

    # 配置摘要
    echo ""
    echo "=========================================="
    echo "  配置摘要"
    echo "=========================================="
    echo "  API Key:        ${api_key:0:8}****${api_key: -4}"
    echo "  管理员用户名:    $username"
    echo "  管理员密码:      ******"
    echo "  群组配置:        ${group_configs:-（未配置，使用默认模型 kimi-k2.5）}"
    echo "  AI API 地址:     $ai_base_url"
    echo "=========================================="
    echo ""
}

setup_env

# ---- 统一修正 .env 权限/属主 ----
# 无论 .env 是本次新生成还是已存在，都确保容器内 appuser(1001) 可读：
# volume 挂载无法在容器内改属主，故宿主机上设属主 1001、权限 640
if [ -f ".env" ]; then
    chown 1001:1001 .env 2>/dev/null || true
    chmod 640 .env
    print_status ".env 权限已修正 (640, 属主 1001)"
fi

# ---- 创建目录 ----

print_status "创建目录..."
mkdir -p logs data

# data/logs 目录需要容器内 appuser(1001) 可写
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
  --name mixin-chatbot \
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
  mixin-chatbot; then
    print_success "容器启动成功"
else
    print_error "容器启动失败"
    docker logs mixin-chatbot 2>/dev/null
    exit 1
fi

# ---- 等待健康检查 ----

print_status "等待服务就绪..."
# HEALTHCHECK: start-period=10s, interval=30s, retries=3
# 第一次有效检查在 ~40s，最多等 90s 覆盖所有 retries
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
    echo "  Webhook:  http://${SERVER_IP}:1011/webhook"
    echo "  管理页面: http://${SERVER_IP}:1011/admin"
    echo "  配置文件: $(pwd)/.env"
    echo "  日志:     $(pwd)/logs/"
    echo "  数据:     $(pwd)/data/"
    echo ""
    echo "  内存限制: 400MB | CPU: 1核"
    echo ""
    echo "  常用命令:"
    echo "    docker logs -f mixin-chatbot     # 实时日志"
    echo "    docker restart mixin-chatbot     # 重启"
    echo "    docker stats mixin-chatbot       # 资源监控"
    echo ""

    print_status "最近日志:"
    docker logs --tail 10 mixin-chatbot 2>&1
else
    print_error "服务启动失败"
    docker logs mixin-chatbot 2>&1
    exit 1
fi
