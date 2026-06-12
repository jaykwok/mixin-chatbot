#!/bin/bash

# Debian 13 服务器安全加固脚本
# 用法: sudo ./setup-server.sh

set -e

if [ "$(id -u)" -ne 0 ]; then
    echo "请使用 root 运行: sudo ./setup-server.sh"
    exit 1
fi

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
    unattended-upgrades \
    apt-listchanges

# 启用 Docker
systemctl enable --now docker

# ---- 防火墙 (UFW) ----

echo "[*] 配置防火墙..."
ufw default deny incoming
ufw default allow outgoing

# SSH
ufw allow 22/tcp comment 'SSH'

# 聊天机器人端口
ufw allow 1011/tcp comment 'Chatbot'

# 启用防火墙 (幂等：已启用则跳过)
if ufw status | grep -q "Status: active"; then
    echo "[+] 防火墙已处于启用状态"
else
    echo "y" | ufw enable
fi
ufw status

echo "[+] 防火墙已启用: 仅开放 SSH(22) 和 Chatbot(1011)"

# ---- fail2ban ----

echo "[*] 配置 fail2ban..."
cat > /etc/fail2ban/jail.local << 'JAILEOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
backend = systemd

[sshd]
enabled = true
port = ssh
maxretry = 3
bantime = 7200
JAILEOF

systemctl enable --now fail2ban
systemctl restart fail2ban

echo "[+] fail2ban 已启用: SSH 3次失败封禁2小时"

# ---- 自动安全更新 ----

echo "[*] 配置自动安全更新..."
cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'UUEOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
UUEOF

cat > /etc/apt/apt.conf.d/20auto-upgrades << 'AUEOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUEOF

echo "[+] 自动安全更新已启用"

# ---- 内核参数优化 (1核1GB) ----

echo "[*] 优化内核参数..."
cat > /etc/sysctl.d/99-chatbot.conf << 'SYSEOF'
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
cat > /etc/docker/daemon.json << 'DJEOF'
{
    "log-driver": "json-file",
    "log-opts": {
        "max-size": "5m",
        "max-file": "2"
    },
    "storage-driver": "overlay2"
}
DJEOF

systemctl restart docker

echo "[+] Docker 日志轮转已配置"

# ---- 完成 ----

echo ""
echo "=========================================="
echo "  服务器加固完成"
echo "=========================================="
echo ""
echo "  防火墙:     UFW (22, 1011)"
echo "  入侵防护:   fail2ban (SSH)"
echo "  自动更新:   安全补丁"
echo "  内核优化:   低内存 + TCP 加固"
echo ""
echo "  下一步: cd /你的项目目录 && ./deploy.sh"
echo ""
