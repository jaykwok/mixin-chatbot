# 量子密信群聊协作机器人

量子密信 IM 平台群聊协作机器人，以 [Pi agent](https://pi.dev)（TypeScript agent 框架）为大脑：收到群聊 @ 消息 → Pi agent 推理（可调用工具）→ 把回复发回群里。

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Bun（原生 TS） |
| Web 框架 | Hono（跑在 Bun.serve） |
| Agent 大脑 | `@earendil-works/pi-coding-agent`（经审计追随最新版，由 `bun.lock` 锁定） |
| 模型接入 | Pi 原生读 `data/models.json`，支持 DashScope / DeepSeek / 智谱等 openai 兼容端点 |
| 部署 | Docker（Debian，oven/bun 镜像）/ Windows 原生 Bun（`scripts/deploy/deploy.ps1`） |

## 工作方式

机器人只接收**文字**消息（群聊 webhook）。Pi agent 拿到后可调用工具：

- 官方工厂：`read` / `bash` / `edit` / `write`（cwd 为本群共享的 `<AGENT_DATA_ROOT>/<group>/workspace`；文件工具只允许访问该 workspace 与当前用户 tmp）
- 自定义：`send_image` / `send_file`（往群里发送图片或文件）

最终回复含 Markdown 格式时发送 **markdown 正文 + text@ 通知**两条消息（markdown 不支持 @，故另发 text 触发通知）；纯文本回复只发送一条带 @ 的 text，避免重复。

**群共享工作区 + 用户临时区**：每个群共用 `<AGENT_DATA_ROOT>/<group>/workspace`，只存长期成果；每次任务的下载、缓存、草稿和转换中间产物放在当前调用用户的 `<AGENT_DATA_ROOT>/<group>/<phone>/tmp`。bash 使用 Pi 官方 `createBashToolDefinition` 的 `spawnHook`，自动把该会话的 `TMPDIR`、`TMP`、`TEMP` 以及常见 npm/Bun/pip 缓存指向用户临时区；Pi 因输出截断产生的完整日志也会迁入这里。会话按 **(群, phone)** 分开，保存在 `<AGENT_DATA_ROOT>/<group>/<phone>/sessions/session.jsonl`，避免不同成员的话题历史分散模型注意力。`groupId` 不适合作为跨平台目录名时改用带 `sha256-` 前缀的完整摘要，防路径穿越和命名碰撞。

**phone 与 Pi sessionId**：`(groupId, phone)` 唯一定位一份会话文件，Pi 的 sessionId 保存在该 JSONL 头部；`/reset` 删除文件后生成新 sessionId。Pi 0.82 自动向 bash 注入 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`，适配层再注入 `PI_GROUP_ID`、`PI_CALLER_PHONE`、`PI_USER_TMP`。`/status` 和创建日志都会显示这层绑定。

**共享工作区串行化**：不同用户仍使用各自会话，但同一群的完整 agent 轮次按 FIFO 串行，避免两个 session 同时改同一 workspace；不同群可并行。当前用户正在执行时发普通消息仍直接走 `session.steer`，指令也不会被队列阻塞。排队请求会收到状态回执，`/reset` 会让该用户尚未执行的旧请求失效。

**长任务心跳**：工具调用不逐条发群消息。正常负载下，任务开始时发送 `🤔 正在思考...`，超过 20 秒后每 20 秒发送一次存活心跳，完成或中断时立即停止；高负载时这些状态消息会优先降频。

**多人发送保护**：出站消息按机器人 callback key 共享 60 秒滑动窗口。达到 12 条时自动暂停可丢弃的思考提示/心跳，为最终回复预留额度；接近上限时每窗口最多发一次预警；关键消息达到 20 条时排队等待窗口释放，不丢最终回复、指令回执或附件。此保护按本地实际 HTTP 发送尝试计数，不依赖平台返回 429——平台即使对超额请求仍返回 200、随后静默丢弃，本地也不会发出第 21 条。

**中途干预**（agent 干活时无需等做完）：
- 发**普通消息** → 作为引导插入（`session.steer`），agent 在下一步纳入；收到回执 `↩️ 已插入干预`。
- 发 **`/指令`**（以 `/` 开头，正常提问绝不误触发）→ 立即处理：

| 指令 | 作用 |
|---|---|
| `/help` | 列出指令 |
| `/stop` | **硬中断**当前任务（`session.abort`，连在跑的工具一并取消） |
| `/status` | 查看忙/闲、Pi sessionId、群工作区队列、待消化干预、最近工具及共享 RPM 窗口 |
| `/cancel` | 撤销尚未被消化的干预消息 |
| `/reset` | 清空当前用户在本群的会话历史，重新开始 |

> 区别：发普通消息（含「停止」）= **软干预**，等当前这批工具调用完、下次调 LLM 前注入，靠模型自觉改方向（杀不掉正在跑的长命令）；`/stop` = **硬停**，立刻取消（含在跑的 bash）。

## 配置

项目无必需的 `.env` 或 `config.json`：

- **AI 配置**（provider / key / model / 元数据）：全部在 `data/models.json`，由 `bun run configure` 调用 `scripts/config/configure.ts` 生成，Pi 原生读取。
- **监听端口**：Linux/Windows 部署脚本每次都会询问，默认优先沿用 `BOT_PORT` 或 `data/bot-port`，否则为 `1011`；选择结果写入 `data/bot-port`，服务、健康检查、隧道探测和运维脚本共用。
- **监听地址**：部署脚本自动设置；直连模式为 `0.0.0.0`，Cloudflare 模式为 `127.0.0.1`。手动启动时可用 `BOT_HOST` 覆盖。
- **群数据总根**（可选）：默认 `./data`，部署时可改（`deploy.ps1`/`deploy.sh` 会问），或直接设环境变量 `AGENT_DATA_ROOT`（相对仓库或绝对路径均可）。群共享成果、当前用户临时文件和独立会话分别位于 `<AGENT_DATA_ROOT>/<group>/workspace`、`<AGENT_DATA_ROOT>/<group>/<phone>/tmp`、`<AGENT_DATA_ROOT>/<group>/<phone>/sessions/session.jsonl`。
- **访问控制**：随机密钥路径（`data/webhook-secret`，应用层）+ 网络层 IP 闸门（直连=UFW / Cloudflare=WAF），见下方「部署模式」与「安全」。
- **开发开关**：生产环境缺少有效 `data/webhook-secret` 时服务拒绝启动；只有隔离的本地调试可显式设置 `ALLOW_INSECURE_WEBHOOK=1`。`BOT_DEBUG=1` 会记录用户消息正文，默认关闭。

Pi 依赖声明保持 `latest`，但部署使用提交进仓库的 `bun.lock` 和 `bun install --frozen-lockfile`，避免未经审计的自动升级。主动追 Pi 新版时运行 `bun update @earendil-works/pi-ai @earendil-works/pi-coding-agent && bun run check`，确认通过后一起提交锁文件。

## Pi 官方实现取舍

- 当前核心直接复用 [Pi SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 的 `AgentSession`、`SessionManager`、`ModelRuntime`、默认资源加载器、compaction/steer/abort，以及 read/bash/edit/write 工具工厂；本项目只保留量子密信回调、群/用户目录策略、工作区队列和发送附件工具。0.82 新增的 bash 会话环境已启用，所有工具也以 `prefer` 使用其 constrained JSON Schema sampling（模型不支持时自动回退）。
- 官方 [pi-chat](https://github.com/earendil-works/pi-chat) 提供 Discord/Telegram 与 Gondolin 微型虚拟机隔离，证明“一频道一个 workspace/runner”的方向合理；但它依赖 QEMU、tmux、Gondolin，并仍面向旧包名的 peer API，不适合直接嵌入现有 Windows/Linux/Docker 部署。
- 历史 Slack bot [`@mariozechner/pi-mom`](https://www.npmjs.com/package/@mariozechner/pi-mom) 已停留在旧命名空间；[`pi-messenger-bridge`](https://pi.dev/packages/pi-messenger-bridge) 是第三方 Slack bridge。二者都不能替代量子密信 webhook 适配。

## 部署模式：直连 / Cloudflare

业务逻辑与部署模式无关（随机密钥路径 + payload 校验对两种模式都生效）。区别只在**网络层**——IP 闸门放哪、webhook URL 怎么填：

| | 直连模式 | Cloudflare 模式 |
|---|---|---|
| 适用 | 有公网 IP、能管防火墙 | 无公网 IP（云电脑/NAT）或想要边缘防护 |
| IP 闸门 | UFW 只放行平台 IP `223.244.14.237`→所选端口 | Cloudflare WAF `ip.src=223.244.14.237` |
| webhook URL | `http://<IP>:<port>/webhook/<secret>` | `https://<域名>/webhook/<secret>` |
| TLS | HTTP（可选：自带反代套 HTTPS） | Cloudflare 自动 |
| 监听范围 | 所选端口对平台 IP 开放 | 仅 `127.0.0.1:<port>`，不直接暴露公网 |

`scripts/deploy/deploy.sh` 启动时交互选择模式并给出对应回调地址 + 配置指引：

- **直连模式**：部署脚本把所选端口的 UFW 规则限定到平台 IP（安全基线）+ 随机密钥路径。走 HTTP，secret 在「平台→服务器」明文，但仅平台 IP 可达；有域名可在前面套 nginx/caddy + 证书升级 HTTPS。
- **Cloudflare 模式**：bot 只监听 `127.0.0.1:<port>`，再由 cloudflared + WAF + 随机密钥路径接入。token 启动的是远程管理隧道，必须在 Cloudflare 控制台把 **Published application → Service** 设为 `http://localhost:<port>`；脚本无法替控制台修改这个源站地址。

## 部署

### 1. 服务器初始化（仅首次）

Debian 服务器，root 运行：

```bash
chmod +x scripts/deploy/*.sh scripts/ops/*.sh scripts/tunnel/*.sh
sudo ./scripts/deploy/setup-server.sh
```

默认按直连模式、bot 端口 `1011` 初始化；SSH 端口优先从当前 SSH 连接和 `sshd` 自动识别。需要覆盖时：

```bash
sudo BOT_PORT=12011 SSH_PORT=2222 ./scripts/deploy/setup-server.sh
# Cloudflare 模式不开放 bot 公网端口：
sudo DEPLOY_MODE=cloudflare ./scripts/deploy/setup-server.sh
```

完成：安装 Docker、UFW 防火墙、fail2ban、自动安全更新、内核优化和 Docker 日志轮转。脚本会先确保当前 SSH/webhook 入口存在，再清理本项目遗留的 UFW 规则；换端口或切换 Cloudflare 不会留下旧入口，也不会因新规则写入失败先删掉仍在工作的入口。

```bash
sudo usermod -aG docker $USER && newgrp docker
```

### 2. 部署应用

```bash
./scripts/deploy/deploy.sh
```

流程：

1. 询问监听端口（默认沿用已有值，否则 `1011`）、部署模式和群数据总根
2. 构建 Docker 镜像（Bun）
3. **AI 配置**：若 `data/models.json` 不存在，在容器内运行 TUI（选 provider、填 key、选模型，元数据从 LiteLLM 抓取）；已存在则询问是否重配
4. 启动容器（host 网络、只读根文件系统、最小权限，挂载 `data/`、`logs/` 和选择的群数据总根）
5. 等待健康检查；失败或超时会中止部署并打印日志

重新配置 AI 后重启 bot 让运行时重新加载：

```bash
docker run --rm -it -v "$(pwd)/data:/app/data" mixin-chatbot bun run configure &&
docker restart mixin-chatbot
```

### 更新

```bash
git pull && ./scripts/deploy/deploy.sh
```

默认配置下，群共享成果保存在 `data/<group>/workspace/`；当前用户的临时文件和会话历史分别保存在 `data/<group>/<phone>/tmp/` 与 `data/<group>/<phone>/sessions/session.jsonl`，更新不丢失。

### Cloudflare 模式（云电脑）部署

适合无公网 IP 的云电脑：bot 只监听云电脑 `127.0.0.1:<port>`，`cloudflared` 经 Cloudflare 隧道接入。

1. `git clone` 仓库到云电脑，按系统部署（选择 **Cloudflare 模式**、确认端口并生成 webhook 密钥）：
   - **Windows Server（云电脑）**：管理员 PowerShell `powershell -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1`（**原生 Bun，无需 Docker**；先装 Git for Windows + Bun。部署脚本使用中文交互，并逐个验证 Git/GNU Bash/Bun 候选路径，避免 `.cmd` 与无扩展名 shim 被合并成一个命令）
   - **Linux**：`./scripts/deploy/deploy.sh`（Docker）
2. 在 Cloudflare Tunnel 控制台把 Published application 的 Service 改为本次选择的 `http://localhost:<port>`。
3. 从 Cloudflare Tunnel 获取 token，任选一种：
   - 把包含 token 的 `.env` **整个文件**拷到云电脑，起隧道时把路径传给脚本即可（脚本能解析 `TUNNEL_TOKEN=...` 形式）。
   - 或把里面的 `TUNNEL_TOKEN` 值写入云电脑 `data/tunnel-token`（默认读取位置）。
   - 或 `export TUNNEL_TOKEN=<值>`。
4. 起隧道。选择 Cloudflare 模式时，部署脚本会在 bot 起来后**自动确保 connector 在线**（Windows：`Cloudflared` 服务没跑就 Start、没装就调用 tunnel 脚本；Linux：没跑就后台启动）。下面命令仅用于首次手动安装或后续重装：
   - **Linux/macOS**：`./scripts/tunnel/start-tunnel.sh [token-file]`
   - **Windows Server**：管理员 PowerShell `powershell -ExecutionPolicy Bypass -File scripts\tunnel\start-tunnel.ps1 [token-file]`（装 cloudflared + 注册为 Windows 服务，开机自启）

   token 解析优先级：位置参数文件 → `$TUNNEL_TOKEN_FILE` → `$TUNNEL_TOKEN`（裸值）→ `data/tunnel-token`。token 文件可以是裸 token，也可以是 `.env` 形式（含 `TUNNEL_TOKEN=...`）。
5. IM 平台回调填：`https://<你的域名>/webhook/<secret>`（secret 来自 deploy 输出）。设置纯 hostname 形式的 `BOT_DOMAIN`（例如 `bot.example.com`，不含协议/端口/路径）后，部署成功会写入 `data/bot-domain`，后续运维脚本会自动检查该域名。

Windows 上的 `data/tunnel-token` 只是安装/修复时的 token 来源；Cloudflared 服务会保存安装时使用的 token，单独修改该文件不会自动更新已安装服务。轮换 token 后运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 repair-tunnel
```

该命令会隐藏 token 内容、强制重装 Cloudflared 服务并复查公网状态。直接重跑 `start-tunnel.ps1` 默认只会启动现有服务，不会静默替换 token。

Windows 管理员部署会优先创建“开机启动、无需用户登录”的 S4U 计划任务；如果服务器策略在注册或实际启动阶段拒绝 S4U，会自动回退为当前用户登录时启动。非管理员部署仍保留前台运行模式；后续也可用 `ops.ps1 foreground` 显式以前台方式启动。

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
│   ├── agent/                  # Pi 运行时、目录策略与工具适配
│   │   ├── runtime.ts          # models.json 加载 + 会话 + 对话入口
│   │   ├── group-queue.ts      # 同群共享 workspace 的 FIFO 执行队列
│   │   ├── local-tools.ts      # Pi 官方工具工厂 + 路径/临时环境适配
│   │   ├── paths.ts            # 群优先的数据目录布局与安全目录名
│   │   └── send-tools.ts       # 发送工具 send_image / send_file
│   ├── core/                   # 共享基础设施
│   │   ├── config.ts           # 参数读取与常量（端口 / 限流 / 日志等）
│   │   └── log.ts              # 日志（console + 文件轮转）
│   ├── integrations/
│   │   └── im.ts               # 量子密信消息/附件与共享 RPM 窗口
│   └── server/                 # HTTP 层
│       ├── index.ts            # 入口：Hono + Bun.serve + /webhook 路由
│       ├── webhook.ts          # 字段校验、去重、入站限流、后台并发派发
│       └── http.ts             # HttpError + 客户端 IP
├── scripts/
│   ├── config/          # AI 配置 TUI
│   ├── deploy/          # Linux/Windows 部署 + 服务器初始化
│   ├── ops/             # doctor/restart/stop/start/logs/uninstall
│   └── tunnel/          # Linux/Windows cloudflared connector
├── tests/               # 按 agent/config/server 分类的 Bun 测试
├── public/favicon.svg
├── data/                # 配置/部署状态/runtime + 群 workspace/用户 tmp/会话
├── logs/                # 应用日志
├── Dockerfile           # oven/bun:1-debian
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
- `--tmpfs /tmp` + `--tmpfs /app/.pi`（运行时内部临时空间）；agent 的共享成果在 `<group>/workspace`，任务中间产物定向到当前用户 `<group>/<phone>/tmp`

### 应用层

- 随机密钥路径鉴权（`data/webhook-secret`，见上）
- 回调 URL 结构校验：https + hostname 白名单 + 约定发送端点 + `key` 参数（防 SSRF / 伪造；细节见 `src/core/config.ts`）
- `phone` 格式、`groupId` 控制字符校验（防路径穿越、日志注入和非法子进程环境）、消息内容 16KB 上限
- 请求去重（30 秒内相同请求跳过，防重复回复）
- 错误信息脱敏（仅记日志，不回传用户）
- read/write/edit 文件工具会解析真实路径，只允许本群 workspace 与当前用户 tmp，阻止 `..` 和符号链接越界。
- ⚠️ `bash` 仍是**非 cwd 沙箱**，可执行任意命令，权限=bot 进程用户；cwd 和临时环境不是 OS 级隔离。仅可信群成员可触发，生产优先使用只读、非 root、丢弃 capabilities 的 Docker 部署。若以后要求对不可信用户开放，应整体接入 Gondolin/容器级沙箱，而不是依赖 shell 字符串过滤。

### 系统层（`scripts/deploy/setup-server.sh`）

- UFW 防火墙（自动识别 SSH 端口；直连时 bot 端口仅平台 IP，Cloudflare 时不开放 bot 端口）
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

**Linux（Docker 部署）**——`scripts/ops/ops.sh` 一站式运维：

```bash
./scripts/ops/ops.sh doctor     # 健康检查（容器/本地/配置；仅 Cloudflare 模式检查隧道和公网）
./scripts/ops/ops.sh restart    # 重启（docker restart）
./scripts/ops/ops.sh logs       # 实时日志（docker logs -f --tail 50）
./scripts/ops/ops.sh stop       # 停止
./scripts/ops/ops.sh uninstall  # 卸载（容器，可选清 image/cloudflared/data）
```

应用日志：`logs/mixin-chatbot.log`（5MB × 3 轮转）；容器层日志 `docker logs mixin-chatbot`。

> 卸载时删除 `data/` 只会清理 AI 配置、webhook 密钥及默认群数据根。若 `AGENT_DATA_ROOT` 指向其他目录，该自定义群数据根会保留，需确认后另行处理。

**Windows Server（云电脑，由 `scripts\deploy\deploy.ps1` 部署）**——`scripts\ops\ops.ps1` 一站式运维：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 doctor     # 健康检查（task/端口/配置；隧道检查按部署模式启用）
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 doctor -Repair # 诊断后自动修复可安全处理的本地故障
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 repair-tunnel  # 按当前 token 来源重装 Cloudflared 服务
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 restart    # 重启
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 foreground # 前台运行（Ctrl+C 停止）
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 logs       # 实时日志
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 stop       # 停止
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 uninstall-tunnel # 停止并卸载 Cloudflared 服务
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 uninstall  # 清理 task/进程/防火墙/launcher，可选清隧道/data/logs
```

`doctor` 会检查计划任务及上次结果、端口占用进程、本地 HTTP、token 来源、Cloudflared 服务、`data/bot-domain` 和公网链路，并为失败项打印对应修复命令。它只确认 token 来源是否可用，无法从 Cloudflared 服务中反查并比较已安装 token；token 有变化时应显式执行 `repair-tunnel`。

## 故障排查

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| 启动报 `无法读取 data/models.json` | 未配置 AI | 运行 configure TUI 生成 `data/models.json` |
| 启动报 `data/webhook-secret 缺失或格式无效` | 密钥文件不存在、编码错误或内容损坏 | 删除该文件后重跑部署脚本生成；不要在生产设置 `ALLOW_INSECURE_WEBHOOK=1` |
| 健康检查超时 | 所选端口冲突 / 启动异常 | Linux 查看 `docker logs mixin-chatbot`；Windows 运行 `ops.ps1 doctor` 与 `ops.ps1 logs`；两边都检查 `data/bot-port` |
| Windows 计划任务存在但机器人未启动 | S4U 被服务器策略拒绝 / task 上次结果异常 | 重跑最新版 `scripts\deploy\deploy.ps1`（会自动回退登录时启动），再执行 `scripts\ops\ops.ps1 doctor` 查看十六进制任务结果 |
| IM 收不到回复 | 回调地址不可达 / 防火墙 / Cloudflare 源站端口不一致 | 直连检查 `ufw status`；Tunnel 检查 Published application 是否指向 `http://localhost:<data/bot-port>` |
| Cloudflare 公网返回 502 | 隧道在线，但本地机器人未启动或源站端口不一致 | 先运行 `ops.ps1 doctor -Repair`，再确认 Published application 指向 `http://localhost:<data/bot-port>` |
| Cloudflare 公网返回 530/1033 或连接失败 | connector 未运行、服务安装 token 已失效、hostname/DNS 异常 | 将最新 token 放到 `data/tunnel-token`，以管理员运行 `ops.ps1 repair-tunnel`，再检查 Cloudflare hostname/DNS |
| 修改 `data/tunnel-token` 后仍连不上 | 已安装服务仍使用旧 token | 运行 `ops.ps1 repair-tunnel`；修改文件本身不会更新服务 |
| 日志显示“发送成功”但群里只收到前 20 条 | 平台对超限请求返回 HTTP 200 后静默丢弃 | 当前版本用本地 60 秒滑动窗口保护，不依赖 429；确认所有实例都已更新且没有另一份 bot 共用同一 callback key |
| AI 回复报错 | models.json 的 key / 模型有误 | 重跑 configure TUI |
| 云电脑迁移后偶发不通 | 前半段（平台→边缘）不稳 | 见 cloudflared 隧道方案（另文） |
