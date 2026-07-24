# 量子密信群聊协作机器人

量子密信 IM 平台群聊协作机器人，以 [Pi agent](https://pi.dev)（TypeScript agent 框架）为大脑：收到群聊 @ 消息 → Pi agent 推理（可调用工具）→ 把回复发回群里。

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Bun（原生 TS） |
| Web 框架 | Hono（跑在 Bun.serve） |
| Agent 大脑 | `@earendil-works/pi-coding-agent`（AgentSession + SessionManager） |
| 模型接入 | Pi 原生读 `data/models.json`，支持 DashScope / DeepSeek / 智谱等 openai 兼容端点 |
| 部署 | Docker（Debian，oven/bun 镜像） |

## 工作方式

机器人只接收**文字**消息（群聊 webhook）。Pi agent 拿到后可调用工具：

- 内置：`read` / `bash` / `edit` / `write`（在 `./data` 目录读写文件、运行终端命令、联网查询）
- 自定义：`send_image` / `send_file`（往群里发送图片或文件）

最终文字回复自动以 **markdown 正文 + text@ 通知**双消息发到群里（markdown 不支持 @，故另发一条 text 触发通知）。

## 配置：零应用配置

应用层无 `.env`、无 `config.json`：

- **AI 配置**（provider / key / model / 元数据）：全部在 `data/models.json`，由 TUI 工具 `scripts/configure.ts` 生成，Pi 原生读取。
- **应用参数**：端口 1011 等均为代码常量（`src/lib/config.ts`）。
- **访问控制**：随机密钥路径（`data/webhook-secret`，应用层）+ 网络层 IP 闸门（直连=UFW / Cloudflare=WAF），见下方「部署模式」与「安全」。

## 部署模式：直连 / Cloudflare

应用层零配置且与模式无关（随机密钥路径 + payload 校验对两种模式都生效）。区别只在**网络层**——IP 闸门放哪、webhook URL 怎么填：

| | 直连模式 | Cloudflare 模式 |
|---|---|---|
| 适用 | 有公网 IP、能管防火墙 | 无公网 IP（云电脑/NAT）或想要边缘防护 |
| IP 闸门 | UFW 只放行平台 IP `223.244.14.237`→1011 | Cloudflare WAF `ip.src=223.244.14.237` |
| webhook URL | `http://<IP>:1011/webhook/<secret>` | `https://<域名>/webhook/<secret>` |
| TLS | HTTP（可选：自带反代套 HTTPS） | Cloudflare 自动 |
| 1011 暴露 | 对平台 IP 开放 | 关闭公网（cloudflared 本地连） |

`deploy.sh` 启动时交互选择模式并给出对应回调地址 + 配置指引：

- **直连模式**：靠 `setup-server.sh` 把 UFW 1011 限定到平台 IP（安全基线）+ 随机密钥路径。走 HTTP，secret 在「平台→服务器」明文，但仅平台 IP 可达；有域名可在前面套 nginx/caddy + 证书反代到 `:1011` 升级 HTTPS。
- **Cloudflare 模式**：`cloudflared` 隧道指向本机 `:1011`（公网 1011 关闭）+ WAF 限定平台 IP + 随机密钥路径。详见下方「安全 → 公网暴露（Cloudflare 三层防护）」。

## 部署

### 1. 服务器初始化（仅首次）

Debian 服务器，root 运行：

```bash
chmod +x setup-server.sh deploy.sh
sudo ./setup-server.sh
```

完成：安装 Docker、UFW 防火墙（22 SSH + 1011 仅平台 IP）、fail2ban、自动安全更新、内核优化、Docker 日志轮转。

```bash
sudo usermod -aG docker $USER && newgrp docker
```

### 2. 部署应用

```bash
./deploy.sh
```

流程：

1. 构建 Docker 镜像（bun）
2. **AI 配置**：若 `data/models.json` 不存在，在容器内运行 TUI（选 provider、填 key、选模型，元数据从 LiteLLM 抓取）；已存在则询问是否重配
3. 启动容器（只读根文件系统、最小权限、挂载 `data/` 与 `logs/`）
4. 等待健康检查、输出服务信息

重新配置 AI（不重新部署）：

```bash
docker run --rm -it -v "$(pwd)/data:/app/data" mixin-chatbot bun run scripts/configure.ts
```

### 更新

```bash
git pull && ./deploy.sh
```

会话历史保存在 `data/sessions/*.jsonl`，更新不丢失。

### Cloudflare 模式（云电脑）部署

适合无公网 IP 的云电脑：bot 跑在云电脑 :1011，`cloudflared` 把 `im-bot.jaykwok.net` 经 Cloudflare 隧道接到本机。

1. `git clone` 仓库到云电脑，`./deploy.sh` 选 **Cloudflare 模式**（bot 起在 :1011，生成 webhook 密钥）。
2. 从服务器拷贝隧道 token：把 `/root/.cpa-bot-tunnel-token.env` 里的 `TUNNEL_TOKEN` 写入云电脑 `data/tunnel-token`（或 `export TUNNEL_TOKEN=...`）。
3. 起隧道（按云电脑系统选一个）：
   - **Linux/macOS**：`./scripts/start-tunnel.sh`
   - **Windows Server**：管理员 PowerShell `powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1`（装 cloudflared + 注册为 Windows 服务，开机自启）
4. IM 平台回调填：`https://im-bot.jaykwok.net/webhook/<secret>`（secret 来自 deploy 输出）。

> 公网 1011 无需开放（`cloudflared` 本地连）。Cloudflare WAF（平台 IP 白名单）在服务端配置。隧道/域名已在服务端建好（`im-bot.jaykwok.net` → 隧道 → 本机 :1011）。

## 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/webhook/<secret>` | POST | IM 平台回调入口；secret 来自 `data/webhook-secret`（未配置时回退开放 `/webhook`，仅内网） |
| `/favicon.svg` | GET | 图标（健康检查用） |

### Webhook 请求格式

```json
{
  "type": "text",
  "textMsg": { "content": "用户消息内容" },
  "phone": "用户手机号",
  "groupId": "群组ID",
  "callBackUrl": "https://imtwo.zdxlz.com/send?key=<robot_key>"
}
```

`callBackUrl` 严格校验：协议 https、hostname 在白名单（`imtwo.zdxlz.com` / `im.zdxlz.com`）、路径须为 `/im-external/v1/webhook/send` 且带 `key` 参数——防 SSRF 与伪造回调。

## 目录结构

```
mixin-chatbot/
├── src/
│   ├── server/                 # HTTP 层
│   │   ├── index.ts            # 入口：Hono + Bun.serve + /webhook 路由
│   │   ├── webhook.ts          # 字段校验、去重、限流、后台异步（per-phone 串行）
│   │   └── http.ts             # HttpError + 客户端 IP
│   ├── agent/                  # Pi agent 大脑
│   │   ├── agent.ts            # models.json 加载 + 运行时 + 会话 + 对话入口
│   │   └── tools.ts            # 发送工具 send_image / send_file
│   ├── im/im.ts                # 量子密信发送层（text/markdown/image/file + 上传）
│   └── lib/                    # 共享基础
│       ├── config.ts           # 纯常量（端口 / 限流 / 日志等）
│       └── log.ts              # 日志（console + 文件轮转）
├── scripts/
│   ├── configure.ts     # TUI：生成 data/models.json（LiteLLM 元数据）
│   ├── start-tunnel.sh  # 云电脑 cloudflared 对接（Linux/macOS）
│   └── start-tunnel.ps1 # 同上（Windows Server，注册为服务）
├── static/favicon.svg
├── data/               # models.json + sessions/*.jsonl（Pi 会话持久化）
├── logs/               # 应用日志
├── Dockerfile          # oven/bun:1-debian
├── deploy.sh           # 部署脚本
├── setup-server.sh     # 服务器加固脚本
└── package.json
```

## 安全

### 公网暴露（Cloudflare 三层防护）

平台 webhook **不带签名**，公网靠三层组合挡未授权调用与重放：

1. **Cloudflare WAF**（IP 闸门）：仅放行平台出口 IP `223.244.14.237` + POST + 路径前缀 `/webhook`，其余 Block。用 `ip.src`（勿用可伪造的 `X-Forwarded-For`）。
   > Free plan 的 `matches`（正则）需 Business+，故 WAF 只做 IP+POST+前缀；`/webhook/<64hex>` 密钥校验由应用层完成。规则匹配前缀不匹配密钥值——密钥轮换不动 Cloudflare。
2. **随机密钥路径** `/webhook/<64hex>`（256bit）：存 `data/webhook-secret`，deploy 首次生成、恒定时长比对、不匹配返 404，旧 `/webhook` 直接 404。泄露时删 `data/webhook-secret` 重部署即重生成。
3. **应用层 payload 校验**（见下）：phone 格式、内容长度、callBackUrl 结构。

> WAF 规则在 Cloudflare 侧配置，切 cloudflared 公网时启用。未配 `data/webhook-secret` 时应用回退开放 `/webhook`（仅内网/本地）。

### 容器层

- `--read-only` 只读根文件系统
- `--cap-drop ALL` + `--security-opt no-new-privileges`
- 非 root 运行（UID 1001）
- `--tmpfs /tmp` + `--tmpfs /app/.pi`（Pi agentDir）

### 应用层

- 随机密钥路径鉴权（`data/webhook-secret`，见上）
- 回调 URL 结构校验：https + hostname 白名单 + 路径 `/im-external/v1/webhook/send` + `key` 参数（防 SSRF / 伪造）
- `phone` 格式校验（防会话文件名路径穿越）、消息内容 16KB 上限
- 请求去重（30 秒内相同请求跳过，防重复回复）
- 错误信息脱敏（仅记日志，不回传用户）
- ⚠️ agent 有 `bash` 工具：仅可信群成员可 @ 触发；工具工作目录限定在 `./data`

### 系统层（setup-server.sh）

- UFW 防火墙（22 + 1011）
- fail2ban（SSH 暴力破解防护）
- 自动安全更新、TCP 加固

## 资源限制（1C1G 服务器）

| 资源 | 限制 |
|------|------|
| 容器内存 | 512MB（swap 768MB） |
| 容器 CPU | 1 核 |
| 应用日志 | 5MB × 3 |
| Docker 日志 | 5MB × 2 |
| 去重字典 | 1000 条 / 30s |

## 日常运维

```bash
docker logs -f mixin-chatbot          # 实时日志
docker restart mixin-chatbot          # 重启
docker stats mixin-chatbot            # 资源占用
```

应用日志：`logs/mixin-chatbot.log`（5MB × 3 轮转）。

## 故障排查

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| 启动报 `无法读取 data/models.json` | 未配置 AI | 运行 configure TUI 生成 `data/models.json` |
| 健康检查超时 | 端口冲突 / 启动异常 | `docker logs mixin-chatbot`，确认 1011 未被占用 |
| IM 收不到回复 | 回调地址不可达 / 防火墙 | 确认 `callBackUrl`、`ufw status` 确认 1011 开放 |
| AI 回复报错 | models.json 的 key / 模型有误 | 重跑 configure TUI |
| 云电脑迁移后偶发不通 | 前半段（平台→边缘）不稳 | 见 cloudflared 隧道方案（另文） |
