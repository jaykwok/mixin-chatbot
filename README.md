# 量子密信群聊协作机器人

量子密信 IM 平台群聊协作机器人，以 [Pi agent](https://pi.dev)（TypeScript agent 框架）为大脑：收到群聊 @ 消息 → Pi agent 推理（可调用工具）→ 把回复发回群里。

- 群成员 @ 机器人提问，agent 可读写文件、执行命令、往群里发图片和文件
- 每个群一个共享工作区存放长期成果，每个成员独立的会话历史与临时目录
- 同群多人可同时跑任务，文件写入自动排队协调
- 干活途中可随时插话干预，或用 `/stop`、`/clear` 等指令直接控制
- 两种部署形态：有公网 IP 走直连，云电脑/NAT 走 Cloudflare 隧道

## 快速开始

Debian 服务器（Docker）：

```bash
chmod +x scripts/deploy/*.sh scripts/ops/*.sh scripts/tunnel/*.sh
sudo ./scripts/deploy/setup-server.sh   # 仅首次：Docker、防火墙、fail2ban 等
./scripts/deploy/deploy.sh              # 交互式：端口、模式、AI 配置、启动
```

Windows Server 云电脑（原生 Bun，无需 Docker）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1
```

部署脚本会输出 webhook 回调地址，填进 IM 平台即可。完整步骤见[部署](#部署)。

## 文档导航

| 想做什么 | 看这里 |
|---|---|
| 让群成员会用这个机器人 | [群聊使用](#群聊使用) |
| 改端口、换模型、调数据目录 | [配置](#配置) |
| 选直连还是 Cloudflare | [部署模式](#部署模式) |
| 首次部署、更新、云电脑部署 | [部署](#部署) |
| 日常重启、看日志、健康检查 | [日常运维](#日常运维) |
| 出问题了 | [故障排查](#故障排查) |
| 理解并发、限流、目录策略怎么实现的 | [设计与实现](#设计与实现) |
| 公网暴露面和沙箱边界 | [安全](#安全) |

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Bun（原生 TS） |
| Web 框架 | Hono（跑在 Bun.serve） |
| Agent 大脑 | `@earendil-works/pi-coding-agent`（版本由 `bun.lock` 锁定） |
| 模型接入 | Pi 原生读 `data/config/models.json`，配置器仅生成 OpenAI Responses API 配置 |
| 部署 | Docker（Debian，oven/bun 镜像）/ Windows 原生 Bun（`scripts/deploy/deploy.ps1`） |

## 群聊使用

机器人只接收**文字**消息（群聊 webhook）。Pi agent 拿到后可调用工具：

- 官方工厂：`read` / `bash` / `edit` / `write`（cwd 为本群共享的 `<GROUP_DATA_ROOT>/<group>/workspace`；文件工具只允许访问该 workspace 与当前用户 tmp）
- 自定义：`send_image` / `send_file`（往群里发送图片或文件）

规范化后的普通文字任务开始时只发送一条 `🤔 正在思考...` 作为接单确认；工具调用和长任务过程不发送周期心跳，只在任务完成、失败、收到指令或确实需要排队时再发消息，避免刷屏。

**中途干预**（agent 干活时无需等做完）：

- 发**普通消息** → 作为引导插入（`session.steer`），agent 在下一步纳入；收到回执 `↩️ 已插入干预`。
- 发 **`/指令`**（以 `/` 开头，正常提问绝不误触发）→ 立即处理：

| 指令 | 作用 |
|---|---|
| `/help` | 列出指令 |
| `/clear` | 停止当前任务、清空当前用户在本群的会话历史；下一条消息开启新会话 |
| `/stop` | **硬中断**当前任务（`session.abort`，连在跑的工具和附件/回复发送一并取消） |
| `/status` | 查看忙/闲、Pi sessionId、群工作区文件协调、待消化干预、最近工具及共享 RPM 窗口 |

> 区别：发普通消息（含「停止」）= **软干预**，等当前这批工具调用完、下次调 LLM 前注入，靠模型自觉改方向（杀不掉正在跑的长命令）；`/stop` = **硬停**，立刻取消（含在跑的 bash）。

<details>
<summary><b>回复格式与分片规则</b></summary>

最终回复确实包含标题、强调、列表、链接、表格或代码等格式时，先发送 Markdown 富文本，再发送一条 `✅ 任务已完成，请查看上方回复` 并 @ 当前用户，确保群聊静音或用户离开页面后仍能收到完成提醒。普通段落直接发送官方 `text`；超过官方单条 5000 字符上限时自动分片且只在最后一片 @ 当前用户。Markdown 的 HTTP 或业务响应明确失败时会转换并降级为 `text@`，不再重复发送完成提醒。同一逻辑回复的全部文本分片，或 Markdown 与完成提醒，共用一个出站 FIFO 位置，不会被其他用户的消息插入中间。

</details>

<details>
<summary><b>机器人提及的解析规则</b></summary>

平台传入的消息会先按「`@` + 机器人名称 + `U+FFA0`」规则移除开头的机器人提及，不绑定具体名称；`U+FFA0` 是平台实际使用、界面显示成空白的半角韩文填充符，普通空格不视为提及分隔符。只移除第一个前置提及，正文里的后续 `@某人` 保持不变。已登记的 `/` 指令（大小写不敏感）不发送思考提示，而是直接返回指令结果；未登记的 `/` 指令直接返回错误说明和完整帮助，不进入 AI。

</details>

## 配置

项目无必需的 `.env` 或 `config.json`。运行时文件统一放入分层的 `data/`，根目录不再直接堆放文件：

```text
data/
├── config/                         # 用户配置与密钥
│   ├── models.json
│   ├── webhook-secret
│   └── tunnel-token
├── state/                          # 部署脚本生成的状态
│   ├── bot-port
│   ├── deploy-mode
│   ├── bot-domain
│   ├── group-data-root
│   └── cloudflared.pid / cloudflared-managed  # Linux PID / Windows 服务归属标记
├── runtime/                        # 可删除、可重建的运行文件
│   ├── bot-launcher.ps1
│   ├── home/                       # Linux 容器任意非 root UID 的可写 HOME
│   └── pi/
└── groups/                         # 默认 GROUP_DATA_ROOT
    └── <group>/
        ├── workspace/
        └── users/<phone>/
            ├── tmp/
            └── session.jsonl
```

- **AI 配置**（Responses provider / base URL / key / model / 元数据 / thinkingLevel）：全部在 `data/config/models.json`，由 `bun run configure` 调用 `scripts/config/configure.ts` 生成，Pi 原生读取 provider/model，本项目读取 thinkingLevel。配置器固定写入 `api: "openai-responses"`；模型支持思考模式时选择 `off/minimal/low/medium/high`（默认 `low`），不支持时固定为 `off`。服务启动时对所选 provider 做只读凭证就绪检查。
- **监听端口与部署状态**：Linux/Windows 部署脚本每次都会询问；端口默认优先沿用 `BOT_PORT` 或 `data/state/bot-port`，否则为 `1011`，部署模式默认优先沿用 `DEPLOY_MODE` 或 `data/state/deploy-mode`。机器人健康且隧道/直连切换成功后，模式、公网域名和主机侧群数据根才统一提交到 `data/state/`。
- **监听地址**：部署脚本自动设置；直连模式为 `0.0.0.0`，Cloudflare 模式为 `127.0.0.1`。手动启动时可用 `BOT_HOST` 覆盖。
- **群数据总根**（可选）：首次默认 `./data/groups`，部署时可改（`deploy.ps1`/`deploy.sh` 会问），或直接设环境变量 `GROUP_DATA_ROOT`（相对仓库或绝对路径均可）。部署成功后主机路径写入 `data/state/group-data-root`，下次部署自动沿用，避免群数据被切到另一目录；配置、部署状态和 runtime 始终保留在项目 `data/` 的分类目录中。
- **访问控制**：随机密钥路径（`data/config/webhook-secret`，应用层）+ 网络层 IP 闸门（直连=系统防火墙 / Cloudflare=WAF），见[部署模式](#部署模式)与[安全](#安全)。
- **开发开关**：生产环境缺少有效 `data/config/webhook-secret` 时服务拒绝启动；只有隔离的本地调试可显式设置 `ALLOW_INSECURE_WEBHOOK=1`。`BOT_DEBUG=1` 会记录用户消息正文，默认关闭。
- **负载上限**：`BOT_MAX_ACTIVE_REQUESTS` 控制已确认但尚未完成的 Pi 后台任务数，默认 `32`，有效范围 `1–1000`；达到上限的新请求不启动模型，而是通过 callback 明确通知当前用户稍后重发。

<details>
<summary><b>依赖与出站适配的维护约定</b></summary>

Pi 依赖声明为 `^0.84.2`，当前 `bun.lock` 锁定 Pi `0.84.2`；部署使用 `bun install --frozen-lockfile`，避免未经审计的自动升级。更新 Pi 依赖时运行 `bun update @earendil-works/pi-ai @earendil-works/pi-coding-agent && bun run check`，确认通过后一起提交锁文件。

`package.json` 将 Pi 间接使用的 `brace-expansion` 统一约束为已修复的 `5.0.8`，避免依赖树重新解析到受已知内存耗尽漏洞影响的 `5.0.7` 及更早版本。

量子密信出站适配按官方 Webhook 文档校验 HTTP 状态及 `ok/code` 业务结果；附件上传使用标准的单文件 `multipart/form-data` 请求：`key`、`type` 是文本字段，`file` 是二进制文件字段（这里的 multipart 指一个请求包含多个字段，不是同时上传多个文件），并兼容从 `data.id` 或 `content.id` 读取 `fileId`。

</details>

## 部署模式

业务逻辑与部署模式无关（随机密钥路径 + payload 校验对两种模式都生效）。区别只在**网络层**——IP 闸门放哪、webhook URL 怎么填：

| | 直连模式 | Cloudflare 模式 |
|---|---|---|
| 适用 | 有公网 IP、能管防火墙 | 无公网 IP（云电脑/NAT）或想要边缘防护 |
| IP 闸门 | 系统防火墙按平台当前回调来源限制到所选端口 | Cloudflare WAF 按平台当前回调来源限制 |
| webhook URL | `http://<IP>:<port>/webhook/<secret>` | `https://<域名>/webhook/<secret>` |
| TLS | HTTP（可选：自带反代套 HTTPS） | Cloudflare 自动 |
| 监听范围 | 所选端口只对平台回调来源开放 | 仅 `127.0.0.1:<port>`，不直接暴露公网 |

`scripts/deploy/deploy.sh` 启动时交互选择模式并给出对应回调地址 + 配置指引：

- **直连模式**：部署脚本把所选端口的系统防火墙规则限定到平台当前回调来源（Linux UFW / Windows 防火墙）+ 随机密钥路径。防火墙不可管理或未启用时拒绝监听 `0.0.0.0`；只有确认已有等效云防火墙后，才可显式设置 `ALLOW_UNMANAGED_FIREWALL=1` 越过本机基线。直连走 HTTP，secret 在「平台→服务器」明文；有域名可在前面套 nginx/caddy + 证书升级 HTTPS。
- **Cloudflare 模式**：bot 只监听 `127.0.0.1:<port>`，再由 cloudflared + WAF + 随机密钥路径接入。token 启动的是远程管理隧道，必须在 Cloudflare 控制台把 **Published application → Service** 设为 `http://localhost:<port>`；脚本无法替控制台修改这个源站地址。

部署脚本会记录由本项目启动或安装的 connector。切换回直连模式时只停止带本项目 PID/服务归属标记的 cloudflared（Windows 同时禁用其开机启动）；发现未记录归属的实例不会按进程名批量终止，但必须人工确认其与本项目无关或入口仍受保护后才能继续。Cloudflare 模式发现未托管 connector 时也必须确认它确实服务当前项目。

Windows 与 Linux 的部署交互保持一致：直接回车采用显示的默认值；端口、模式、目录、域名、确认项或 token 来源输入无效时会说明原因并原地重试，不会因普通输入错误退出整个部署。Cloudflare 公网域名既可输入纯 hostname，也可粘贴不带端口、路径或查询参数的 `http(s)` 根 URL，脚本会规范化为 hostname；按 `Ctrl+C` 可主动取消。

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

1. 询问监听端口（默认沿用已有值，否则 `1011`）、部署模式、群数据总根和 Cloudflare 公网域名；无效输入会原地重试
2. 构建 Docker 镜像（Bun）
3. **AI 配置**：若 `data/config/models.json` 不存在，在容器内运行 TUI（填写 Responses provider、base URL、key 和模型，元数据从 LiteLLM 抓取；支持思考时选择 thinkingLevel）；已存在则询问是否重配
4. 验证 bind mount 对容器身份可读写，再启动容器（普通用户部署沿用当前非 root UID/GID；root 部署固定降权到 UID/GID 1001；host 网络、只读根文件系统、最小权限）
5. 等待健康检查并完成隧道/直连切换；失败、超时或中途取消会移除未提交的新容器并恢复旧容器，旧 UFW 入口到成功提交后才清理

重新配置 AI 后重启 bot 让运行时重新加载：

```bash
docker run --rm -it --user "$(stat -c '%u:%g' data)" -e HOME=/app/data/runtime/home -v "$(pwd)/data:/app/data" mixin-chatbot bun run configure &&
docker restart mixin-chatbot
```

### 更新

```bash
git pull && ./scripts/deploy/deploy.sh
```

默认配置下，群共享成果保存在 `data/groups/<group>/workspace/`；当前用户的临时文件和会话历史分别保存在 `data/groups/<group>/users/<phone>/tmp/` 与 `data/groups/<group>/users/<phone>/session.jsonl`，更新不丢失。

### Cloudflare 模式（云电脑）部署

适合无公网 IP 的云电脑：bot 只监听云电脑 `127.0.0.1:<port>`，`cloudflared` 经 Cloudflare 隧道接入。

1. `git clone` 仓库到云电脑，按系统部署（选择 **Cloudflare 模式**、确认端口并生成 webhook 密钥）：
   - **Windows Server（云电脑）**：管理员 PowerShell `powershell -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1`（**原生 Bun，无需 Docker**；先装 Git for Windows + Bun。部署脚本使用中文交互，并逐个验证 Git/GNU Bash/Bun 候选路径，避免 `.cmd` 与无扩展名 shim 被合并成一个命令）
   - **Linux**：`./scripts/deploy/deploy.sh`（Docker）
2. 在 Cloudflare Tunnel 控制台把 Published application 的 Service 改为本次选择的 `http://localhost:<port>`。
3. 从 Cloudflare Tunnel 获取 token，任选一种：
   - 把包含 token 的 `.env` **整个文件**拷到云电脑，起隧道时把路径传给脚本即可（脚本能解析 `TUNNEL_TOKEN=...` 形式）。
   - 或把里面的 `TUNNEL_TOKEN` 值写入云电脑 `data/config/tunnel-token`（默认读取位置）。
   - 或 `export TUNNEL_TOKEN=<值>`。
4. 起隧道。选择 Cloudflare 模式时，部署脚本会在 bot 起来后**自动确保 connector 在线**（Windows：`Cloudflared` 服务没跑就 Start、没装就调用 tunnel 脚本；Linux：没跑就后台启动）。下面命令仅用于首次手动安装或后续重装：
   - **Linux/macOS**：`./scripts/tunnel/start-tunnel.sh [token-file]`
   - **Windows Server**：管理员 PowerShell `powershell -ExecutionPolicy Bypass -File scripts\tunnel\start-tunnel.ps1 [token-file]`（装 cloudflared + 注册为 Windows 服务，开机自启）

   token 解析优先级：位置参数文件 → `$TUNNEL_TOKEN_FILE` → `$TUNNEL_TOKEN`（裸值）→ `data/config/tunnel-token`。token 文件可以是裸 token，也可以是 `.env` 形式（含 `TUNNEL_TOKEN=...`）。
5. IM 平台回调填：`https://<你的域名>/webhook/<secret>`（secret 来自 deploy 输出）。部署交互或 `BOT_DOMAIN` 可填写纯 hostname（如 `bot.example.com`），也可填写仅含根域名的 URL（如 `https://bot.example.com`）；脚本会规范化后写入 `data/state/bot-domain`，后续运维脚本自动检查该域名。

Windows 上的 `data/config/tunnel-token` 只是安装/修复时的 token 来源；Cloudflared 服务会保存安装时使用的 token，单独修改该文件不会自动更新已安装服务。轮换 token 后运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 repair-tunnel
```

该命令会隐藏 token 内容、强制重装 Cloudflared 服务并复查公网状态。直接重跑 `start-tunnel.ps1` 默认只会启动现有服务，不会静默替换 token。

Windows 管理员部署会优先创建“开机启动、无需用户登录”的 S4U 计划任务；如果服务器策略在注册或实际启动阶段拒绝 S4U，会自动回退为当前用户登录时启动。非管理员部署仍保留前台运行模式；后续也可用 `ops.ps1 foreground` 显式以前台方式启动。

> bot 端口无需对公网开放。Cloudflare WAF（平台回调来源白名单）和 Published application 的源站端口都在 Cloudflare 侧配置。

## 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/webhook/<secret>` | POST | IM 平台回调入口；secret 来自 `data/config/webhook-secret`。缺失或无效时生产服务拒绝启动 |
| `/favicon.svg` | GET | 图标（健康检查用） |

## 日常运维

**Linux（Docker 部署）**——`scripts/ops/ops.sh` 一站式运维：

```bash
./scripts/ops/ops.sh doctor     # 健康检查（群数据根/容器/本地/配置；仅 Cloudflare 模式检查隧道和公网）
./scripts/ops/ops.sh restart    # 重启（docker restart）
./scripts/ops/ops.sh logs       # 实时日志（docker logs -f --tail 50）
./scripts/ops/ops.sh stop       # 停止
./scripts/ops/ops.sh uninstall  # 卸载（容器，可选清 image/cloudflared/data）
```

应用日志：`logs/mixin-chatbot.log`（当前 5MB + 3 份轮转备份）；容器层日志 `docker logs mixin-chatbot`。

> 卸载时删除 `data/` 会清理配置、部署状态、runtime 和默认群数据根。若 `GROUP_DATA_ROOT` 指向其他目录，该自定义群数据根会保留，需确认后另行处理。

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

`doctor` 会检查群数据总根、计划任务及上次结果、端口占用进程、本地 HTTP、token 来源、Cloudflared 服务、`data/state/bot-domain` 和公网链路，并为失败项打印对应修复命令。它只确认 token 来源是否可用，无法从 Cloudflared 服务中反查并比较已安装 token；token 有变化时应显式执行 `repair-tunnel`。

`uninstall` / `uninstall-tunnel` 的删除确认在 Windows 与 Linux 上都只接受 y/n；输入其他内容会重新询问，直接回车默认取消，避免误删服务或数据。

## 故障排查

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| 启动报 `无法读取 data/config/models.json` | 未配置 AI | 运行 configure TUI 生成 `data/config/models.json` |
| 启动报 `data/config/webhook-secret 缺失或格式无效` | 密钥文件不存在、编码错误或内容损坏 | 删除该文件后重跑部署脚本生成；不要在生产设置 `ALLOW_INSECURE_WEBHOOK=1` |
| 健康检查超时 | 所选端口冲突 / 启动异常 | Linux 查看 `docker logs mixin-chatbot`；Windows 运行 `ops.ps1 doctor` 与 `ops.ps1 logs`；两边都检查 `data/state/bot-port` |
| Windows 计划任务存在但机器人未启动 | S4U 被服务器策略拒绝 / task 上次结果异常 | 重跑最新版 `scripts\deploy\deploy.ps1`（会自动回退登录时启动），再执行 `scripts\ops\ops.ps1 doctor` 查看十六进制任务结果 |
| IM 收不到回复 | 回调地址不可达 / 防火墙 / Cloudflare 源站端口不一致 | 直连检查 `ufw status`；Tunnel 检查 Published application 是否指向 `http://localhost:<data/state/bot-port>` |
| Cloudflare 公网返回 502 | 隧道在线，但本地机器人未启动或源站端口不一致 | 先运行 `ops.ps1 doctor -Repair`，再确认 Published application 指向 `http://localhost:<data/state/bot-port>` |
| Cloudflare 公网返回 530/1033 或连接失败 | connector 未运行、服务安装 token 已失效、hostname/DNS 异常 | 将最新 token 放到 `data/config/tunnel-token`，以管理员运行 `ops.ps1 repair-tunnel`，再检查 Cloudflare hostname/DNS |
| 修改 `data/config/tunnel-token` 后仍连不上 | 已安装服务仍使用旧 token | 运行 `ops.ps1 repair-tunnel`；修改文件本身不会更新服务 |
| 日志显示“发送成功”但群里只收到前 20 条 | 平台对超限请求返回 HTTP 200 后静默丢弃 | 当前版本用本地 60 秒滑动窗口保护，不依赖 429；确认所有实例都已更新且没有另一份 bot 共用同一 callback key |
| AI 回复报错 | models.json 的 key / 模型有误 | 重跑 configure TUI |
| 云电脑迁移后偶发不通 | 前半段（平台→边缘）不稳 | 见 cloudflared 隧道方案（另文） |

## 设计与实现

面向维护者的行为细节。日常使用和部署不需要读这一节。

<details>
<summary><b>一群一个机器人实例</b></summary>

官方出站接口会向 Webhook key 关联的全部未解散群组推送；消息体里的可选 `groupId` 只描述 @ 上下文，并未定义为目标群选择器，因此回复目标仍由入站 `callBackUrl` 中的机器人 key 决定。多个群可以填写同一个本项目 webhook 接收地址，但必须分别在每个群里“新建”独立的自定义会话机器人，不能把同一个机器人实例添加到多个群。服务会记录不含明文密钥的 key 短指纹；运行期间一旦发现同一 key 对应多个 `groupId`，立即停止相关请求并返回 409，避免继续广播串群。冲突记录保留到进程重启；无冲突且闲置 24 小时的观察会回收，最多保存 1000 个 key，容量耗尽时对未知 key 失败关闭。

</details>

<details>
<summary><b>群共享工作区 + 用户临时区</b></summary>

每个群共用 `<GROUP_DATA_ROOT>/<group>/workspace`，只存长期成果及该群共用的 `.venv`；每次任务的下载、缓存、草稿和转换中间产物放在当前调用用户的 `<GROUP_DATA_ROOT>/<group>/users/<phone>/tmp`。bash 使用 Pi 官方 `createBashToolDefinition` 的 `spawnHook`，自动把该会话的 `TMPDIR`、`TMP`、`TEMP` 以及常见 npm/Bun/pip/uv 缓存指向用户临时区，同时把 `VIRTUAL_ENV` / `UV_PROJECT_ENVIRONMENT` 固定到群 workspace 的 `.venv`，把 `PYTHONIOENCODING` 固定为 UTF-8，并按 Pi 通用约定注入 `AI_AGENT=pi` 与 `PI_CODING_AGENT=true`（Pi 只在自己的 CLI/RPC 入口设这两个标记，内嵌 SDK 时需要显式导出）；Pi 因输出截断产生的完整日志也会迁入这里。会话按 **(群, phone)** 分开，保存在 `<GROUP_DATA_ROOT>/<group>/users/<phone>/session.jsonl`，避免不同成员的话题历史分散模型注意力。`groupId` 不适合作为跨平台目录名时改用带 `sha256-` 前缀的完整摘要，防路径穿越和命名碰撞。

</details>

<details>
<summary><b>phone 与 Pi sessionId</b></summary>

`(groupId, phone)` 唯一定位一份会话文件，Pi 的 sessionId 保存在该 JSONL 头部；`/clear` 删除文件，下一条普通消息会生成新 sessionId。Pi 向 bash 注入 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`，适配层再注入 `PI_GROUP_ID`、`PI_CALLER_PHONE`、`PI_USER_TMP`。`/status` 和创建日志都会显示这层绑定。

</details>

<details>
<summary><b>共享工作区文件级并发</b></summary>

同一群的不同用户可以同时运行完整 agent 轮次。`read` 不加锁；`edit` / `write` 按规范化后的目标路径共用 FIFO，同一文件串行、不同文件并行，两个任务同时创建同名新文件也会串行。`bash` 通过 `mutates` 声明可能创建、修改、重命名或删除的路径，并与 `edit` / `write` 共用路径锁；纯读取传 `[]`，目标无法列清或属于批量修改时传 `["."]`，临时退化为整个 workspace 独占。`mutates` 只是排队用的调度信息而非边界（bash 起的是真实 shell，声明拦不住任何写入），所以落在 workspace 外的路径——通常是调用者自己的 tmp——不需要锁，直接忽略而不是拒绝；声明缺失或格式不对时退回整个 workspace 独占这一保守选项，不会让整次调用失败。锁在工具完成或抛错后由 `finally` 自动释放；等待锁时收到 `/stop`、`/clear` 或进程关闭信号会撤销自己的排队位置，活动工具则在真正停止后再释放，避免后续任务越过仍在执行的写操作。禁止启动会在工具返回后继续修改 workspace 的后台进程。当前用户正在执行时发普通消息仍直接走 `session.steer`，指令不受文件锁阻塞。

</details>

<details>
<summary><b>工具调用策略</b></summary>

保持 Pi 的磁盘扩展发现关闭，只加载本进程显式注册的内联策略。该策略只剩一条：阻止脱离工具生命周期的后台进程——它活得比工具的 AbortSignal 长，问题出在意图而非参数上，再来一轮只会换个 spawn 写法，因此使用 Pi 0.84.1 的 `{ block: true, terminate: true }`，同批调用全部终止时直接向用户返回原因，不再额外调用一次模型。路径边界不在这里重复判断：`read` / `edit` / `write` 由 `AllowedPathGuard`、`send_image` / `send_file` 由 `loadBytes` 在执行阶段做 canonical path/符号链接校验，越界会变成一次普通的工具报错，模型可以在同一轮里自行改正。

</details>

<details>
<summary><b>多人发送保护（出站 RPM）</b></summary>

本项目使用的自定义 Webhook 机器人按 callback key 共享 20 RPM（不同于推送机器人的约 10 RPM）。达到 12 条时自动暂停可丢弃的非关键状态消息，为最终回复预留额度；接近上限时每窗口最多发一次预警；关键消息达到 20 条时排队等待窗口释放，不丢最终回复、指令回执或附件。平台若以 HTTP 429 或 HTTP 200 业务响应明确限流，本地窗口立即标记为 20/20，当前失败的关键消息继续占据 FIFO 队首，冷却后由它先重发。此保护按本地实际 HTTP 发送尝试计数；平台即使对超额请求返回 HTTP 200 后静默丢弃，本地也不会主动发出第 21 条。`/stop`、`/clear` 和进程关闭会取消对应的下载、上传、窗口等待及在途请求，避免关闭流程被冷却窗口拖住。

</details>

<details>
<summary><b>入站保护</b></summary>

payload 字段必须使用官方 JSON 类型，`callBackUrl` 只能包含一个非空 `key`；30 秒内同一已入队 `(群, phone, content)` 的重复投递直接确认且不消耗限额。新请求按 `(群, phone)` 独立限制为 10 RPM，同一手机号在不同群互不影响；后台最多同时保留 32 个 Pi 任务（可用 `BOT_MAX_ACTIVE_REQUESTS` 调整）。平台不会替业务拒绝自动重投，因此容量满或用户触发入站限流时，接收端仍 ACK 200，并通过该请求的 callback URL 在群内 @ 用户说明“本条未入队，请稍后重发”，避免静默丢消息；同一用户尚未送达的同类回执会合并。

</details>

<details>
<summary><b>Pi 官方实现取舍</b></summary>

- 当前核心直接复用 [Pi SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 的 `AgentSession`、`SessionManager`、`ModelRuntime`、默认资源加载器、compaction/steer/abort、内联 `tool_call` 策略，以及 read/bash/edit/write 工具工厂；本项目只保留量子密信回调、群/用户目录策略、工作区文件协调和发送附件工具。bash 会话与调用者临时环境已启用，工具 schema 只使用当前 TypeBox 支持的 API，并通过 Pi 官方 `defineTool` 助手接入；所有工具以 `prefer` 使用 constrained JSON Schema sampling（模型不支持时自动回退）。
- 官方 [pi-chat](https://github.com/earendil-works/pi-chat) 提供 Discord/Telegram 与 Gondolin 微型虚拟机隔离，证明“一频道一个 workspace/runner”的方向合理；但它依赖 QEMU、tmux、Gondolin，并仍面向旧包名的 peer API，不适合直接嵌入现有 Windows/Linux/Docker 部署。

</details>

## 目录结构

```
mixin-chatbot/
├── src/
│   ├── agent/                  # Pi 运行时、目录策略与工具适配
│   │   ├── runtime.ts          # 模型加载 + 会话 + 对话入口
│   │   ├── workspace-coordinator.ts # 同文件 FIFO、多文件并发与 bash 声明式路径锁
│   │   ├── local-tools.ts      # Pi 官方工具工厂 + 路径/临时环境适配
│   │   ├── paths.ts            # 群优先的数据目录布局与安全目录名
│   │   └── send-tools.ts       # 发送工具 send_image / send_file
│   ├── core/                   # 共享基础设施
│   │   ├── config.ts           # 参数读取与常量（端口 / 限流 / 日志等）
│   │   ├── storage.ts          # data/config、state、runtime、groups 路径定义
│   │   └── log.ts              # 日志（console + 文件轮转）
│   ├── integrations/
│   │   ├── callback-route.ts   # callback key 与群关系保护
│   │   ├── markdown.ts         # Markdown 检测与纯文本降级
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
├── tests/               # 按 agent/config/core/integrations/server 分类的 Bun 测试
├── public/favicon.svg
├── data/
│   ├── config/          # models.json、webhook-secret、tunnel-token
│   ├── state/           # 部署状态及 cloudflared PID/归属标记
│   ├── runtime/         # Windows launcher、Pi 可重建运行目录
│   └── groups/          # <group>/workspace + users/<phone>/{tmp,session.jsonl}
├── logs/                # 应用日志
├── Dockerfile           # oven/bun:1-debian
└── package.json
```

## 安全

### 公网暴露（Cloudflare 三层防护）

平台 webhook **不带签名**，公网靠三层组合挡未授权调用与重放：

1. **Cloudflare WAF**（来源闸门）：对路径前缀 `/webhook`，仅放行平台当前配置的回调来源 + POST，其他 webhook 请求 Block；`/favicon.svg` 可保留用于公网健康检查。来源规则使用 Cloudflare 的连接源地址字段（勿用可伪造的 `X-Forwarded-For`）。
   > WAF 只需匹配 IP、POST 和路径前缀；`/webhook/<64hex>` 的密钥值由应用层校验，因此轮换密钥时无需改 WAF。
2. **随机密钥路径** `/webhook/<64hex>`（256bit）：存 `data/config/webhook-secret`，deploy 首次生成、固定长度摘要比对、不匹配返 404，旧 `/webhook` 直接 404。泄露时删该文件、重部署即重新生成。
3. **应用层 payload 校验**（见下）：phone 格式、内容长度、callBackUrl 结构。

> WAF 规则在 Cloudflare 侧配置，使用 tunnel 公网接入时启用。未配或误配 `data/config/webhook-secret` 时生产服务默认拒绝启动；只有显式设置 `ALLOW_INSECURE_WEBHOOK=1` 才开放本地开发端点 `/webhook`。

### 容器层

- `--read-only` 只读根文件系统
- `--cap-drop ALL` + `--security-opt no-new-privileges`
- `--init` 回收孤儿进程，`--pids-limit=256` 限制进程数量
- 非 root 运行（普通用户部署沿用其 UID/GID；root 部署固定为 UID/GID 1001）；可写 `HOME` 固定到 `data/runtime/home/`，避免自定义 UID 落到镜像内不可写的 `/home/appuser`
- `--tmpfs /tmp` 提供容器系统临时空间；Pi 内部可重建文件集中在 `data/runtime/pi/`，agent 的任务中间产物定向到 `data/groups/<group>/users/<phone>/tmp/`

### 应用层

- 随机密钥路径鉴权（`data/config/webhook-secret`，见上）
- 回调 URL 结构校验：https + hostname 白名单 + 约定发送端点 + `key` 参数（防 SSRF / 伪造；细节见 `src/core/config.ts`）
- payload 字段类型、`phone` 格式、`groupId` 控制字符/行分隔符校验（防路径穿越、日志注入和非法子进程环境）、消息内容 16KB 上限
- 请求去重（30 秒内相同请求跳过）及按 `(群, phone)` 隔离的 10 RPM 入站窗口
- Pi 后台在途任务默认最多 32 个（`BOT_MAX_ACTIVE_REQUESTS`）；超限请求 ACK 后通过 callback 通知用户重发
- 错误信息脱敏（仅记日志，不回传用户）
- read/write/edit 文件工具会解析真实路径，只允许本群 workspace 与当前用户 tmp，阻止 `..` 和符号链接越界。
- ⚠️ `bash` 仍是**非 cwd 沙箱**，可执行任意命令，权限=bot 进程用户；cwd 和临时环境不是 OS 级隔离。仅可信群成员可触发，生产优先使用只读、非 root、丢弃 capabilities 的 Docker 部署。若以后要求对不可信用户开放，应整体接入 Gondolin/容器级沙箱，而不是依赖 shell 字符串过滤。

### 系统层（`scripts/deploy/setup-server.sh`）

- UFW 防火墙（自动识别 SSH 端口；直连时 bot 端口仅允许平台当前回调来源，Cloudflare 时不开放 bot 端口）
- fail2ban（SSH 暴力破解防护）
- 自动安全更新、TCP 加固

## 资源限制（1C1G 服务器）

| 资源 | 限制 |
|------|------|
| 容器内存 | 512MB（swap 768MB） |
| 容器 CPU | 1 核 |
| 容器进程数 | 256 |
| 应用日志 | 当前 5MB + 3 份轮转备份 |
| Docker 日志 | 5MB × 2 |
| 去重字典 | 1000 条 / 30s |
| 入站限流字典 | 10000 个 `(群, phone)`；容量满时新键按限流处理，ACK 后 callback 通知重发 |
| 后台在途任务 | 默认 32；可用 `BOT_MAX_ACTIVE_REQUESTS` 设为 1–1000 |
| callback 路由观察 | 1000 个 key；无冲突项闲置 24h 回收 |
