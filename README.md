# AI 聊天机器人

量子密信 IM 平台聊天机器人，基于 FastAPI + 阿里云 DashScope API。

## 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | FastAPI + Uvicorn |
| AI | AsyncOpenAI (DashScope 兼容接口) |
| 存储 | SQLite (aiosqlite) 会话持久化 |
| HTTP | httpx 异步请求 |
| 部署 | Docker (Debian 13) |

## 部署指南

### 前提条件

- Debian 13 服务器 (已测试)
- 阿里云 DashScope API Key

### 第一步：服务器初始化 (仅首次)

将项目上传到服务器后，运行初始化脚本：

```bash
chmod +x setup-server.sh deploy.sh
sudo ./setup-server.sh
```

该脚本会自动完成以下配置：

| 配置项 | 说明 |
|--------|------|
| Docker | 安装并启用 docker.io |
| UFW 防火墙 | 默认拒绝入站，仅开放 22 (SSH) 和 1011 (Chatbot) |
| fail2ban | SSH 连续 3 次登录失败后封禁 IP 2 小时 |
| 自动安全更新 | 通过 unattended-upgrades 自动安装安全补丁 |
| 内核优化 | swappiness=10、TCP 加固、SYN Flood 防护 |
| Docker 日志 | 全局日志轮转 (单文件 5MB，最多 2 份) |

脚本需要 root 权限。执行完成后，确保当前用户已加入 docker 组：

```bash
sudo usermod -aG docker $USER
newgrp docker
```

### 第二步：配置文件

#### `.env` (必填)

```
DASHSCOPE_API_KEY=your_api_key
APP_USERNAME=admin
APP_PASSWORD=your_password
GROUP_CONFIGS=群组ID1:模型名1,群组ID2:模型名2
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

实际示例：

```
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxx
APP_USERNAME=admin
APP_PASSWORD=MyStr0ngPass!
GROUP_CONFIGS=10086:qwen-plus,10010:kimi-k2.5
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

| 变量 | 说明 |
|------|------|
| `DASHSCOPE_API_KEY` | 阿里云 DashScope API 密钥 |
| `APP_USERNAME` | 管理页面登录用户名 |
| `APP_PASSWORD` | 管理页面登录密码 |
| `GROUP_CONFIGS` | 群组模型配置 (可选)，格式为 `群组ID:模型名`，多个用逗号分隔 |
| `AI_BASE_URL` | AI API 地址 (可选)，默认阿里云国内版，国际版改为 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |

- 群组 ID 可在管理页面的活跃会话列表中查看，也可从服务器日志获取
- 未匹配到配置的群组使用默认模型 `kimi-k2.5`
- 修改后需重启容器生效：`docker restart chatbot`

### 第三步：部署应用

```bash
./deploy.sh
```

脚本执行流程：

1. 检查 Docker 权限、必要文件、API Key 配置
2. 创建 `logs/`、`data/` 目录并设置权限
3. 停止并清理旧容器 (如有)
4. 构建 Docker 镜像，清理悬空镜像回收磁盘
5. 启动容器 (只读文件系统、最小权限)
6. 等待健康检查通过
7. 输出服务信息

部署成功后输出：

```
==========================================
  部署完成
==========================================

  Webhook:  http://<服务器IP>:1011/webhook
  管理页面: http://<服务器IP>:1011/admin
```

### 更新部署

代码更新后重新运行即可，会自动替换旧容器：

```bash
git pull
./deploy.sh
```

会话数据保存在 `data/` 目录中，更新不会丢失。

## 日常运维

### 常用命令

```bash
docker logs -f chatbot        # 查看实时日志
docker restart chatbot         # 重启服务
docker stop chatbot            # 停止服务
docker stats chatbot           # 查看资源占用
docker exec -it chatbot bash    # 进入容器 (只读，仅供排查)
```

### 日志位置

| 日志 | 位置 | 轮转策略 |
|------|------|---------|
| 应用日志 | `logs/chatbot.log` | 5MB x 3 份 |
| Docker 日志 | `docker logs chatbot` | 5MB x 2 份 |

### 数据管理

- 会话数据库：`data/sessions.db` (SQLite)
- 会话可永久保留（设置config.py的SESSION_TIMEOUT=0），避免超时清空
- 历史消息上限：每用户保留最近 20 条消息（约 10 轮对话）
- 管理页面最多展示最近 500 个会话
- 后台每 5 分钟执行磁盘容量检查
- 数据库超过 5GB 自动按比例删除最旧会话

## 接口说明

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/webhook` | POST | 无 | IM 平台 Webhook 回调入口 |
| `/admin` | GET | Basic Auth | Web 管理页面 |
| `/admin/api` | GET | Basic Auth | 管理页面数据接口 (JSON) |

### Webhook 请求格式

IM 平台推送的 JSON 格式：

```json
{
    "type": "text",
    "textMsg": { "content": "用户消息内容" },
    "phone": "用户手机号",
    "groupId": "群组ID",
    "callBackUrl": "https://im.zdxlz.com/..."
}
```

### 管理页面

访问 `http://<服务器IP>:1011/admin`，浏览器会弹出 Basic Auth 登录框。

功能：
- 查看所有活跃会话、所属群组 ID 及最近对话预览
- 查看群组模型配置
- 每 30 秒自动刷新

## 目录结构

```
chatbot/
├── app.py                # FastAPI 主应用 (路由、去重、异步调度)
├── ai_service.py         # AI 模型调用 (AsyncOpenAI 流式接收)
├── im_service.py         # IM 平台消息回调 (httpx + 失败重试)
├── session_manager.py    # 会话持久化 (aiosqlite + LRU 缓存)
├── auth.py               # Basic Auth 认证 (常量时间比较)
├── config.py             # 集中配置管理 (.env 加载 + 所有常量)
├── utils.py              # 日志配置
├── requirements.txt      # Python 依赖
├── Dockerfile            # Docker 镜像定义 (Python 3.13-slim)
├── .dockerignore         # Docker 构建排除列表
├── .gitignore            # Git 忽略规则
├── deploy.sh             # 应用部署脚本
├── setup-server.sh       # 服务器初始化脚本 (防火墙/fail2ban/内核)
├── static/
│   ├── admin.html        # 管理页面 (前后端分离，fetch API)
│   └── favicon.svg       # 网站图标
├── data/                 # SQLite 数据库 (Docker volume 挂载)
└── logs/                 # 应用日志 (Docker volume 挂载)
```

## 安全措施

### 容器层

| 措施 | 说明 |
|------|------|
| `--read-only` | 容器文件系统只读，无法写入恶意文件 |
| `--cap-drop ALL` | 移除所有 Linux capabilities |
| `--security-opt no-new-privileges` | 禁止进程提权 |
| 非 root 运行 | 容器内以 UID 1001 (appuser) 运行 |
| `--tmpfs /tmp:size=10m` | 仅 /tmp 可写，限制 10MB |

### 应用层

| 措施 | 说明 |
|------|------|
| 回调 URL 校验 | 解析 hostname 校验，防止 SSRF |
| 请求去重 | 30 秒内相同请求自动跳过，防止重复回复 |
| 错误脱敏 | 异常信息不返回给用户，仅记录到服务端日志 |
| Auth 时序安全 | 使用 `hmac.compare_digest` 防止时序攻击 |

### 系统层

| 措施 | 说明 |
|------|------|
| UFW 防火墙 | 仅开放 22 和 1011 端口 |
| fail2ban | SSH 暴力破解防护 |
| 自动安全更新 | Debian 安全补丁自动安装 |
| TCP 加固 | SYN Cookie、禁用 ICMP 重定向 |

## 资源限制

针对低配服务器 (1核 / 1GB 内存 / 20GB SSD) 优化：

| 资源 | 限制 |
|------|------|
| 容器内存 | 400MB (swap 512MB) |
| 容器 CPU | 1 核 |
| 应用日志 | 5MB x 3 份 = 15MB |
| Docker 日志 | 5MB x 2 份 = 10MB |
| 会话数据库 | 超过 5GB 按比例清理至 4GB |
| 内存缓存 | LRU 100 个活跃会话 |
| 去重字典 | 最多 1000 条（30秒 TTL） |
| 管理 API | 最多返回 500 个会话 |
| 内核 swappiness | 10 (优先使用物理内存) |

## 故障排查

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| 容器启动后立刻退出 | `.env` 配置缺失或格式错误 | `docker logs chatbot` 查看错误信息，检查 `.env` 中必填项是否完整 |
| 健康检查超时 | 端口冲突或应用启动异常 | `docker logs chatbot` 查看启动日志，确认 1011 端口未被占用 |
| IM 消息收不到回复 | 回调地址不可达或防火墙拦截 | 确认 webhook 地址配置正确，检查 `ufw status` 确认 1011 端口已开放 |
| AI 回复超时或报错 | API Key 无效或网络不通 | 检查 `.env` 中 `DASHSCOPE_API_KEY` 是否正确，确认服务器可访问阿里云 API |
| 管理页面无法登录 | 用户名密码错误 | 检查 `.env` 中 `APP_USERNAME` 和 `APP_PASSWORD`，修改后 `docker restart chatbot` |
| 磁盘空间不足 | 日志或数据库过大 | `docker system prune -f` 清理镜像缓存，检查 `data/sessions.db` 大小 |

## 更新日志

### 2026-04-01

- **会话永久保留**: 取消 30 分钟无活动自动清空机制，会话不再因超时丢失
- **修复并发竞态**: 同一用户快速连发消息时，使用 per-user 锁保护会话读写，防止历史消息丢失
- **管理 API 加分页上限**: 最多返回最近 500 个会话，防止数据量过大导致内存爆炸或浏览器崩溃
- **去重字典加容量上限**: 限制最大 1000 条，防止高并发下内存无限增长
- **去重 key 改用原始内容**: 替换 `hash()` 避免哈希碰撞和跨进程不一致问题
- **错误回复容错**: 请求处理失败后发送错误提示时，捕获发送异常避免静默丢失
- **修复 incremental_vacuum 无效问题**: 数据库初始化时设置 `auto_vacuum=INCREMENTAL`
- **优化数据库容量清理**: 基于行数比例一次性清理，替代 WAL 模式下文件大小不准确的循环检测
