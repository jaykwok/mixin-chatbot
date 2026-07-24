# 量子密信群聊协作机器人

量子密信 IM 平台群聊协作机器人，以 [Pi agent](https://pi.dev)（TypeScript agent 框架）为大脑：收到群聊 @ 消息 → Pi agent 推理（可调用工具）→ 把回复发回群里。

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Bun（原生 TS） |
| Web 框架 | Hono（跑在 Bun.serve） |
| Agent 大脑 | `@earendil-works/pi-coding-agent`（AgentSession + SessionManager） |
| 模型接入 | Pi 原生读 `data/models.json`，支持 DashScope / DeepSeek / 智谱等 openai 兼容端点 |
| 部署 | Docker（Debian，oven/bun 镜像）/ Windows 原生 Bun（`deploy.ps1`） |

## 工作方式

机器人只接收**文字**消息（群聊 webhook）。Pi agent 拿到后可调用工具：

- 内置：`read` / `bash` / `edit` / `write`（每个用户在独立的 `<AGENT_CWD>/<phone>/tmp` 中读写文件、运行终端命令、联网查询）
- 自定义：`send_image` / `send_file`（往群里发送图片或文件）

最终回复含 Markdown 格式时发送 **markdown 正文 + text@ 通知**两条消息（markdown 不支持 @，故另发 text 触发通知）；纯文本回复只发送一条带 @ 的 text，避免重复。

**文件与会话隔离**：每个用户有独立的 `<AGENT_CWD>/<phone>/tmp` 工作目录；会话按 **(phone, 群)** 隔离，保存在 `<AGENT_CWD>/<phone>/sessions/<groupId>.jsonl`。`groupId` 不符合安全字符集时用完整 SHA-256 命名，防穿越、防碰撞。

**长任务心跳**：工具调用不逐条发群消息。正常负载下，任务开始时发送 `🤔 正在思考...`，超过 20 秒后每 20 秒发送一次存活心跳，完成或中断时立即停止；高负载时这些状态消息会优先降频。

**多人发送保护**：出站消息按机器人 callback key 共享 60 秒滑动窗口。达到 12 条时自动暂停可丢弃的思考提示/心跳，为最终回复预留额度；接近上限时每窗口最多发一次预警；关键消息达到 20 条时排队等待窗口释放，不丢最终回复、指令回执或附件。此保护按本地实际 HTTP 发送尝试计数，不依赖平台返回 429——平台即使对超额请求仍返回 200、随后静默丢弃，本地也不会发出第 21 条。

**中途干预**（agent 干活时无需等做完）：
- 发**普通消息** → 作为引导插入（`session.steer`），agent 在下一步纳入；收到回执 `↩️ 已插入干预`。
- 发 **`/指令`**（以 `/` 开头，正常提问绝不误触发）→ 立即处理：

| 指令 | 作用 |
|---|---|
| `/help` | 列出指令 |
| `/stop` | **硬中断**当前任务（`session.abort`，连在跑的工具一并取消） |
| `/status` | 查看忙/闲、待消化的干预、最近工具及机器人共享 RPM 窗口 |
| `/cancel` | 撤销尚未被消化的干预消息 |
| `/reset` | 清空本群会话历史，重新开始 |

> 区别：发普通消息（含「停止」）= **软干预**，等当前这批工具调用完、下次调 LLM 前注入，靠模型自觉改方向（杀不掉正在跑的长命令）；`/stop` = **硬停**，立刻取消（含在跑的 bash）。

## 配置

项目无必需的 `.env` 或 `config.json`：

- **AI 配置**（provider / key / model / 元数据）：全部在 `data/models.json`，由 TUI 工具 `scripts/configure.ts` 生成，Pi 原生读取。
- **监听端口**：`deploy.sh` 和 `deploy.ps1` 每次部署都会询问，默认优先沿用 `BOT_PORT` 或 `data/bot-port`，否则为 `1011`；选择结果写入 `data/bot-port`，服务、健康检查、隧道探测和运维脚本共用。
- **监听地址**：部署脚本自动设置；直连模式为 `0.0.0.0`，Cloudflare 模式为 `127.0.0.1`。手动启动时可用 `BOT_HOST` 覆盖。
- **用户目录总根**（可选）：默认 `./data`，部署时可改（`deploy.ps1`/`deploy.sh` 会问），或直接设环境变量 `AGENT_CWD`（相对仓库或绝对路径均可）。每个用户的临时文件和会话分别位于 `<AGENT_CWD>/<phone>/tmp`、`<AGENT_CWD>/<phone>/sessions`。
- **访问控制**：随机密钥路径（`data/webhook-secret`，应用层）+ 网络层 IP 闸门（直连=UFW / Cloudflare=WAF），见下方「部署模式」与「安全」。
- **开发开关**：生产环境缺少有效 `data/webhook-secret` 时服务拒绝启动；只有隔离的本地调试可显式设置 `ALLOW_INSECURE_WEBHOOK=1`。`BOT_DEBUG=1` 会记录用户消息正文，默认关闭。

## 部署模式：直连 / Cloudflare

业务逻辑与部署模式无关（随机密钥路径 + payload 校验对两种模式都生效）。区别只在**网络层**——IP 闸门放哪、webhook URL 怎么填：

| | 直连模式 | Cloudflare 模式 |
|---|---|---|
| 适用 | 有公网 IP、能管防火墙 | 无公网 IP（云电脑/NAT）或想要边缘防护 |
| IP 闸门 | UFW 只放行平台 IP `223.244.14.237`→所选端口 | Cloudflare WAF `ip.src=223.244.14.237` |
| webhook URL | `http://<IP>:<port>/webhook/<secret>` | `https://<域名>/webhook/<secret>` |
| TLS | HTTP（可选：自带反代套 HTTPS） | Cloudflare 自动 |
| 监听范围 | 所选端口对平台 IP 开放 | 仅 `127.0.0.1:<port>`，不直接暴露公网 |

`deploy.sh` 启动时交互选择模式并给出对应回调地址 + 配置指引：

- **直连模式**：部署脚本把所选端口的 UFW 规则限定到平台 IP（安全基线）+ 随机密钥路径。走 HTTP，secret 在「平台→服务器」明文，但仅平台 IP 可达；有域名可在前面套 nginx/caddy + 证书升级 HTTPS。
- **Cloudflare 模式**：bot 只监听 `127.0.0.1:<port>`，再由 cloudflared + WAF + 随机密钥路径接入。token 启动的是远程管理隧道，必须在 Cloudflare 控制台把 **Published application → Service** 设为 `http://localhost:<port>`；脚本无法替控制台修改这个源站地址。

## 部署

### 1. 服务器初始化（仅首次）

Debian 服务器，root 运行：

```bash
chmod +x scripts/setup-server.sh scripts/deploy.sh scripts/ops.sh scripts/start-tunnel.sh
sudo ./scripts/setup-server.sh
```

默认按端口 `1011` 初始化；需要其他初始端口时：

```bash
sudo BOT_PORT=12011 ./scripts/setup-server.sh
```

完成：安装 Docker、UFW 防火墙（22 SSH + bot 端口仅平台 IP）、fail2ban、自动安全更新、内核优化、Docker 日志轮转。之后 `deploy.sh` 若选择不同端口，也会同步新增对应 UFW 规则。

```bash
sudo usermod -aG docker $USER && newgrp docker
```

### 2. 部署应用

```bash
./scripts/deploy.sh
```

流程：

1. 询问监听端口（默认沿用已有值，否则 `1011`）、部署模式和用户目录总根
2. 构建 Docker 镜像（Bun）
3. **AI 配置**：若 `data/models.json` 不存在，在容器内运行 TUI（选 provider、填 key、选模型，元数据从 LiteLLM 抓取）；已存在则询问是否重配
4. 启动容器（host 网络、只读根文件系统、最小权限，挂载 `data/`、`logs/` 和选择的用户目录总根）
5. 等待健康检查；失败或超时会中止部署并打印日志

重新配置 AI 后重启 bot 让运行时重新加载：

```bash
docker run --rm -it -v "$(pwd)/data:/app/data" mixin-chatbot bun run scripts/configure.ts &&
docker restart mixin-chatbot
```

### 更新

```bash
git pull && ./scripts/deploy.sh
```

默认配置下，会话历史保存在 `data/<phone>/sessions/<groupId>.jsonl`（按 phone+群隔离），工作文件保存在 `data/<phone>/tmp/`，更新不丢失。

### Cloudflare 模式（云电脑）部署

适合无公网 IP 的云电脑：bot 只监听云电脑 `127.0.0.1:<port>`，`cloudflared` 经 Cloudflare 隧道接入。

1. `git clone` 仓库到云电脑，按系统部署（选择 **Cloudflare 模式**、确认端口并生成 webhook 密钥）：
   - **Windows Server（云电脑）**：管理员 PowerShell `powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1`（**原生 Bun，无需 Docker**；先装 Git for Windows + Bun。部署脚本会定位 Git Bash 并把它加入 bot 的 PATH）
   - **Linux**：`./scripts/deploy.sh`（Docker）
2. 在 Cloudflare Tunnel 控制台把 Published application 的 Service 改为本次选择的 `http://localhost:<port>`。
3. 准备隧道 token（来自服务器 `/root/.cpa-bot-tunnel-token.env`），任选一种：
   - 最省事：把服务器那个 `.env` **整个文件**拷到云电脑，起隧道时把路径传给脚本即可（脚本能解析 `TUNNEL_TOKEN=...` 形式）。
   - 或把里面的 `TUNNEL_TOKEN` 值写入云电脑 `data/tunnel-token`（默认读取位置）。
   - 或 `export TUNNEL_TOKEN=<值>`。
4. 起隧道。选 Cloudflare 模式时，`deploy.ps1`/`deploy.sh` 会在 bot 起来后**自动确保 connector 在线**（Windows：`Cloudflared` 服务没跑就 Start、没装就调 `start-tunnel.ps1` 装；Linux：没跑就后台起 `start-tunnel.sh`）。下面命令仅用于首次手动安装或后续重装：
   - **Linux/macOS**：`./scripts/start-tunnel.sh [token-file]`
   - **Windows Server**：管理员 PowerShell `powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1 [token-file]`（装 cloudflared + 注册为 Windows 服务，开机自启）

   token 解析优先级：位置参数文件 → `$TUNNEL_TOKEN_FILE` → `$TUNNEL_TOKEN`（裸值）→ `data/tunnel-token`。token 文件可以是裸 token，也可以是 `.env` 形式（含 `TUNNEL_TOKEN=...`）。
5. IM 平台回调填：`https://im-bot.jaykwok.net/webhook/<secret>`（secret 来自 deploy 输出）。

> bot 端口无需对公网开放。Cloudflare WAF（平台 IP 白名单）和 Published application 的源站端口都在 Cloudflare 侧配置。

## 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/webhook/<secret>` | POST | IM 平台回调入口；secret 来自 `data/webhook-secret`。缺失或无效时生产服务拒绝启动 |
| `/favicon.svg` | GET | 图标（健康检查用） |

## 目录结构

```
mixin-chatbot/
├── src/
│   ├── server/                 # HTTP 层
│   │   ├── index.ts            # 入口：Hono + Bun.serve + /webhook 路由
│   │   ├── webhook.ts          # 字段校验、去重、入站限流、后台并发派发
│   │   └── http.ts             # HttpError + 客户端 IP
│   ├── agent/                  # Pi agent 大脑
│   │   ├── agent.ts            # models.json 加载 + 运行时 + 会话 + 对话入口
│   │   └── tools.ts            # 发送工具 send_image / send_file
│   ├── im/im.ts                # 发送层（消息/附件 + 共享 RPM 滑动窗口）
│   └── lib/                    # 共享基础
│       ├── config.ts           # 参数读取与常量（端口 / 限流 / 日志等）
│       └── log.ts              # 日志（console + 文件轮转）
├── scripts/
│   ├── configure.ts     # TUI：生成 data/models.json（LiteLLM 元数据）
│   ├── deploy.sh        # Linux 部署（Docker）
│   ├── deploy.ps1       # Windows Server 部署（原生 Bun，无 Docker）
│   ├── setup-server.sh  # Linux 服务器加固（Docker/UFW/fail2ban）
│   ├── start-tunnel.sh  # 云电脑 cloudflared 对接（Linux/macOS）
│   ├── start-tunnel.ps1 # 同上（Windows Server，注册为服务）
│   ├── ops.sh           # Linux 运维（Docker）：doctor/restart/stop/start/logs/uninstall
│   └── ops.ps1          # Windows 运维：同上
├── static/favicon.svg
├── data/               # 配置/部署状态 + 默认用户根：<phone>/{tmp,sessions/<groupId>.jsonl}
├── logs/               # 应用日志
├── Dockerfile          # oven/bun:1-debian
└── package.json
```

## 安全

### 公网暴露（Cloudflare 三层防护）

平台 webhook **不带签名**，公网靠三层组合挡未授权调用与重放：

1. **Cloudflare WAF**（IP 闸门）：对路径前缀 `/webhook`，仅放行平台出口 IP `223.244.14.237` + POST，其他 webhook 请求 Block；`/favicon.svg` 可保留用于公网健康检查。用 `ip.src`（勿用可伪造的 `X-Forwarded-For`）。
   > WAF 只需匹配 IP、POST 和路径前缀；`/webhook/<64hex>` 的密钥值由应用层校验，因此轮换密钥时无需改 WAF。
2. **随机密钥路径** `/webhook/<64hex>`（256bit）：存 `data/webhook-secret`，deploy 首次生成、恒定时长比对、不匹配返 404，旧 `/webhook` 直接 404。泄露时删 `data/webhook-secret` 重部署即重生成。
3. **应用层 payload 校验**（见下）：phone 格式、内容长度、callBackUrl 结构。

> WAF 规则在 Cloudflare 侧配置，使用 tunnel 公网接入时启用。未配或误配 `data/webhook-secret` 时生产服务默认拒绝启动；只有显式设置 `ALLOW_INSECURE_WEBHOOK=1` 才开放本地开发端点 `/webhook`。

### 容器层

- `--read-only` 只读根文件系统
- `--cap-drop ALL` + `--security-opt no-new-privileges`
- 非 root 运行（UID 1001）
- `--tmpfs /tmp` + `--tmpfs /app/.pi`（运行时内部临时空间）；agent 产出的工作文件仍在每个用户自己的 `<phone>/tmp`

### 应用层

- 随机密钥路径鉴权（`data/webhook-secret`，见上）
- 回调 URL 结构校验：https + hostname 白名单 + 约定发送端点 + `key` 参数（防 SSRF / 伪造；细节见 `src/lib/config.ts`）
- `phone` 格式校验（防会话文件名路径穿越）、消息内容 16KB 上限
- 请求去重（30 秒内相同请求跳过，防重复回复）
- 错误信息脱敏（仅记日志，不回传用户）
- ⚠️ agent 有 `bash` 工具（**非 cwd 沙箱**，可执行任意命令，权限=bot 进程用户）：仅可信群成员可 @ 触发；内置工具默认工作目录按用户绑定到 `<AGENT_CWD>/<phone>/tmp`

### 系统层（setup-server.sh）

- UFW 防火墙（22 + 部署所选 bot 端口，bot 端口仅平台 IP）
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

**Linux（Docker 部署）**——`scripts/ops.sh` 一站式运维：

```bash
./scripts/ops.sh doctor     # 健康检查（容器/本地/配置；仅 Cloudflare 模式检查隧道和公网）
./scripts/ops.sh restart    # 重启（docker restart）
./scripts/ops.sh logs       # 实时日志（docker logs -f --tail 50）
./scripts/ops.sh stop       # 停止
./scripts/ops.sh uninstall  # 卸载（容器，可选清 image/cloudflared/data）
```

应用日志：`logs/mixin-chatbot.log`（5MB × 3 轮转）；容器层日志 `docker logs mixin-chatbot`。

> 卸载时删除 `data/` 只会清理 AI 配置、webhook 密钥及默认用户根。若 `AGENT_CWD` 指向其他目录，该自定义用户根会保留，需确认后另行处理。

**Windows Server（云电脑，`deploy.ps1` 部署的）**——`scripts\ops.ps1` 一站式运维：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ops.ps1 doctor     # 健康检查（task/端口/配置；隧道检查按部署模式启用）
powershell -ExecutionPolicy Bypass -File scripts\ops.ps1 restart    # 重启
powershell -ExecutionPolicy Bypass -File scripts\ops.ps1 logs       # 实时日志
powershell -ExecutionPolicy Bypass -File scripts\ops.ps1 stop       # 停止
powershell -ExecutionPolicy Bypass -File scripts\ops.ps1 uninstall  # 卸载（task/进程，可选清 cloudflared/data）
```

## 故障排查

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| 启动报 `无法读取 data/models.json` | 未配置 AI | 运行 configure TUI 生成 `data/models.json` |
| 启动报 `data/webhook-secret 缺失或格式无效` | 密钥文件不存在、编码错误或内容损坏 | 删除该文件后重跑部署脚本生成；不要在生产设置 `ALLOW_INSECURE_WEBHOOK=1` |
| 健康检查超时 | 所选端口冲突 / 启动异常 | `docker logs mixin-chatbot`，并查看 `data/bot-port` 确认实际端口 |
| IM 收不到回复 | 回调地址不可达 / 防火墙 / Cloudflare 源站端口不一致 | 直连检查 `ufw status`；Tunnel 检查 Published application 是否指向 `http://localhost:<data/bot-port>` |
| 日志显示“发送成功”但群里只收到前 20 条 | 平台对超限请求返回 HTTP 200 后静默丢弃 | 当前版本用本地 60 秒滑动窗口保护，不依赖 429；确认所有实例都已更新且没有另一份 bot 共用同一 callback key |
| AI 回复报错 | models.json 的 key / 模型有误 | 重跑 configure TUI |
| 云电脑迁移后偶发不通 | 前半段（平台→边缘）不稳 | 见 cloudflared 隧道方案（另文） |
