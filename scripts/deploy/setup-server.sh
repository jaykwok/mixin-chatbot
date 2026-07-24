#!/bin/bash

# Debian 13 服务器安全加固脚本
# 用法: sudo ./scripts/deploy/setup-server.sh

set -euo pipefail

# 量子密信平台出口 IP（webhook 来源）；UFW 只放行它访问机器人端口。均可用环境变量覆盖。
PLATFORM_IP="${PLATFORM_IP:-223.244.14.237}"
BOT_PORT="${BOT_PORT:-1011}"
DEPLOY_MODE="${DEPLOY_MODE:-direct}"
if ! [[ "$BOT_PORT" =~ ^[0-9]+$ ]] || [ "$BOT_PORT" -lt 1 ] || [ "$BOT_PORT" -gt 65535 ]; then
    echo "BOT_PORT 必须是 1–65535 的整数" >&2
    exit 1
fi
if [ "$DEPLOY_MODE" != "direct" ] && [ "$DEPLOY_MODE" != "cloudflare" ]; then
    echo "DEPLOY_MODE 必须是 direct 或 cloudflare" >&2
    exit 1
fi

# 优先沿用显式 SSH_PORT，其次取当前 SSH 连接的服务端口，再查询 sshd。
if [ -z "${SSH_PORT:-}" ] && [ -n "${SSH_CONNECTION:-}" ]; then
    SSH_PORT="$(printf '%s\n' "$SSH_CONNECTION" | awk '{print $4}')"
fi
if [ -z "${SSH_PORT:-}" ] && command -v sshd >/dev/null 2>&1; then
    SSH_PORT="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)"
fi
SSH_PORT="${SSH_PORT:-22}"
if ! [[ "$SSH_PORT" =~ ^[0-9]+$ ]] || [ "$SSH_PORT" -lt 1 ] || [ "$SSH_PORT" -gt 65535 ]; then
    echo "SSH_PORT 必须是 1–65535 的整数" >&2
    exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "请使用 root 运行: sudo ./scripts/deploy/setup-server.sh"
    exit 1
fi

remove_managed_ufw_rules() {
    local preserve_port="${1:-}" preserve_ip="${2:-}" kept=0
    local rule_numbers=()
    local line number
    while IFS= read -r line; do
        [[ "$line" == *"Mixin-Chatbot (平台IP)"* ]] || continue
        if [ -n "$preserve_port" ] && [ "$kept" -eq 0 ] &&
            [[ "$line" == *"${preserve_port}/tcp"* && "$line" == *"$preserve_ip"* ]]; then
            kept=1
            continue
        fi
        number="$(sed -n 's/^[[:space:]]*\[[[:space:]]*\([0-9][0-9]*\)\].*/\1/p' <<< "$line")"
        [ -n "$number" ] && rule_numbers+=("$number")
    done < <(ufw status numbered)
    local sorted_numbers=()
    mapfile -t sorted_numbers < <(printf '%s\n' "${rule_numbers[@]}" | sed '/^$/d' | sort -rn)
    for number in "${sorted_numbers[@]}"; do
        ufw --force delete "$number" >/dev/null
    done
}

remove_managed_ssh_rules() {
    local kept=0
    local rule_numbers=()
    local line number
    while IFS= read -r line; do
        [[ "$line" == *"Mixin-Chatbot SSH"* ]] || continue
        if [ "$kept" -eq 0 ] && [[ "$line" == *"${SSH_PORT}/tcp"* ]]; then
            kept=1
            continue
        fi
        number="$(sed -n 's/^[[:space:]]*\[[[:space:]]*\([0-9][0-9]*\)\].*/\1/p' <<< "$line")"
        [ -n "$number" ] && rule_numbers+=("$number")
    done < <(ufw status numbered)
    local sorted_numbers=()
    mapfile -t sorted_numbers < <(printf '%s\n' "${rule_numbers[@]}" | sed '/^$/d' | sort -rn)
    for number in "${sorted_numbers[@]}"; do
        ufw --force delete "$number" >/dev/null
    done
}

echo "[*] Debian 13 服务器安全加固..."

# ---- 系统更新 ----

echo "[*] 更新系统..."
apt-get update -qq && apt-get upgrade -y -qq

# ---- 安装必要工具 ----

echo "[*] 安装 Docker 和安全工具..."
apt-get install -y -qq \
    docker.io \
    ufw \
    fail2ban \
    jq \
    unattended-upgrades \
    apt-listchanges

# 启用 Docker
systemctl enable --now docker

# ---- 防火墙 (UFW) ----

echo "[*] 配置防火墙..."
ufw default deny incoming
ufw default allow outgoing

# SSH：使用当前连接/sshd 检测到的端口，避免自定义端口服务器被锁在门外。
ufw allow "$SSH_PORT"/tcp comment 'Mixin-Chatbot SSH'
remove_managed_ssh_rules

# Mixin Chatbot 端口仅直连模式开放；先添加当前入口，再删除旧入口，避免失败时锁死 webhook。
if [ "$DEPLOY_MODE" = "direct" ]; then
    ufw allow from "$PLATFORM_IP" to any port "$BOT_PORT" proto tcp comment 'Mixin-Chatbot (平台IP)'
    remove_managed_ufw_rules "$BOT_PORT" "$PLATFORM_IP"
else
    remove_managed_ufw_rules
fi

# 启用防火墙 (幂等：已启用则跳过)
if ufw status | grep -q "Status: active"; then
    echo "[+] 防火墙已处于启用状态"
else
    echo "y" | ufw enable
fi
ufw status

if [ "$DEPLOY_MODE" = "direct" ]; then
    echo "[+] 防火墙已启用: SSH(${SSH_PORT}) + Mixin-Chatbot(${BOT_PORT}, 仅 ${PLATFORM_IP})"
else
    echo "[+] 防火墙已启用: 仅开放 SSH(${SSH_PORT})；机器人使用 Cloudflare loopback 模式"
fi

# ---- fail2ban ----

echo "[*] 配置 fail2ban..."
cat > /etc/fail2ban/jail.d/mixin-chatbot.local << JAILEOF
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
backend = systemd

[sshd]
enabled = true
port = $SSH_PORT
maxretry = 3
bantime = 7200
JAILEOF

systemctl enable --now fail2ban
systemctl restart fail2ban

echo "[+] fail2ban 已启用: SSH 3次失败封禁2小时"

# ---- 自动安全更新 ----

echo "[*] 配置自动安全更新..."
cat > /etc/apt/apt.conf.d/52mixin-chatbot-unattended-upgrades << 'UUEOF'
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
UUEOF

cat > /etc/apt/apt.conf.d/52mixin-chatbot-periodic << 'AUEOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUEOF

echo "[+] 自动安全更新已启用"

# ---- 内核参数优化 (1核1GB) ----

echo "[*] 优化内核参数..."
cat > /etc/sysctl.d/99-mixin-chatbot.conf << 'SYSEOF'
# 减少 swap 使用倾向 (1GB 内存尽量用物理内存)
vm.swappiness=10

# 更快回收内存中的缓存
vm.vfs_cache_pressure=200

# TCP 优化
net.core.somaxconn=256
net.ipv4.tcp_max_syn_backlog=256
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_tw_reuse=1

# 防止 SYN Flood
net.ipv4.tcp_syncookies=1

# 禁用不需要的网络功能
net.ipv4.conf.all.accept_redirects=0
net.ipv4.conf.all.send_redirects=0
net.ipv4.icmp_echo_ignore_broadcasts=1
SYSEOF

sysctl --system > /dev/null 2>&1

echo "[+] 内核参数已优化"

# ---- Docker 日志轮转 ----

echo "[*] 配置 Docker 日志轮转..."
mkdir -p /etc/docker
DOCKER_CONFIG='{"log-driver":"json-file","log-opts":{"max-size":"5m","max-file":"2"}}'
if [ -s /etc/docker/daemon.json ]; then
    if ! jq empty /etc/docker/daemon.json >/dev/null 2>&1; then
        echo "[-] /etc/docker/daemon.json 不是有效 JSON，拒绝覆盖；请先修复该文件" >&2
        exit 1
    fi
    jq --argjson desired "$DOCKER_CONFIG" '. * $desired' /etc/docker/daemon.json > /etc/docker/daemon.json.mixin-chatbot.tmp
else
    printf '%s\n' "$DOCKER_CONFIG" | jq . > /etc/docker/daemon.json.mixin-chatbot.tmp
fi
install -m 0644 /etc/docker/daemon.json.mixin-chatbot.tmp /etc/docker/daemon.json
rm -f /etc/docker/daemon.json.mixin-chatbot.tmp

systemctl restart docker

echo "[+] Docker 日志轮转已配置"

# ---- 完成 ----

echo ""
echo "=========================================="
echo "  服务器加固完成"
echo "=========================================="
echo ""
if [ "$DEPLOY_MODE" = "direct" ]; then
    echo "  防火墙:     UFW (SSH ${SSH_PORT}, bot ${BOT_PORT})"
else
    echo "  防火墙:     UFW (SSH ${SSH_PORT}; bot 仅 loopback)"
fi
echo "  入侵防护:   fail2ban (SSH)"
echo "  自动更新:   安全补丁"
echo "  内核优化:   低内存 + TCP 加固"
echo ""
echo "  下一步: cd /你的项目目录 && ./scripts/deploy/deploy.sh"
echo ""
