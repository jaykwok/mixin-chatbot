# 部署与配置

[返回 README](../README.md) · [管理台指南](tui.md) · [运维手册](operations.md)

首次部署按“选择部署方式 → 执行部署 → 配置平台入口”完成，再同步群资料并验证。日常调整优先使用向导；后半部分的配置表和目录说明用于查阅。

**首次部署**：[环境要求](#选择部署方式) · [执行部署](#执行部署) · [平台入口](#配置平台入口)

**配置参考**：[模型配置](#模型配置) · [运行设置](#运行设置) · [数据目录与备份](#数据目录) · [大文件外链](#大文件外链配置)

## 选择部署方式

| 方式 | 主机要求 | 文档解析环境 |
| --- | --- | --- |
| Windows 原生 | Bun 1.4.3+、Git for Windows 的 GNU Bash、原生 `uv.exe`；管理员 PowerShell 部署 | Python 3.14 群 venv 按需准备；Word/PPT 预览另需 LibreOffice |
| Linux / Docker | glibc Linux、Git、Docker Engine、Bash、curl、coreutils、util-linux 的 `flock`；rootful Docker 由 root 部署和升级，rootless Docker 由其所属用户部署；直连模式需要 UFW 及 root / sudo 权限 | 镜像预装 Python 3.14、锁定的文档库、LibreOffice 和中文字体 |

Linux 工具进程监督需要访问 `/proc`；不支持 macOS、Alpine/musl。Docker 的配置向导与应用运行在镜像内，宿主机无需额外安装 Bun；若使用[运维界面](tui.md#运维界面)，则需在宿主机安装 Bun 1.4.3+。

rootful Docker（以 root 运行的默认安装）下，部署、升级、继续和回滚都要由 root 执行，例如 `sudo bash scripts/deploy/deploy.sh`：只有 root 能完整查看镜像存储所在磁盘的剩余空间，并按服务的身份给新建的文件设置属主。docker 组中的普通用户会在任何提问、构建和停机之前被拒绝，脚本不会自动 sudo。rootless Docker 由它所属的普通用户运行，不要用 sudo。

容器进程的身份：真正的首次部署时，root 部署的容器降权到 UID/GID 1001，并把挂载目录的属主改成它；rootless Docker 下以容器内的 root 运行，它映射回宿主机上的部署用户，所以挂载目录仍归这个用户。之后的重新部署和升级沿用原容器 `mixin-chatbot`（运行或停止均可）的数值 UID/GID：停机前从原容器读取并核对，写入本次事务的快照，预览、迁移、验证实例、正式实例以及中断后的继续和回滚都用它；只给本次新建的目录和文件设置属主，不批量改已有数据的属主。原容器的身份不能可靠确定时（不是数值 UID:GID、数据目录不是本项目的、与 Docker 的模式不符），部署和升级在停机前停止，不猜测。原容器已被删除但部署过时，重新部署按 `data/state` 的属主提出身份，经确认后才使用；升级要求原容器存在。以前由 docker 组普通用户部署的实例改由 root 升级后，服务仍以原来的 UID/GID 运行。检出属于那个用户，git 拒绝以 root 操作它（仓库中的钩子和配置会以 root 运行）：确认信任这份检出后，由 root 执行一次 `git config --global --add safe.directory <项目目录>`，脚本不会代为加入；此后 root 升级时写入检出的文件属于 root。用旧版 `ops.sh update` 第一次这样升级时，升级完成后旧入口自带的体检仍按旧规则以 1001:1001 运行一次性容器校验模型配置，读不了服务身份的配置文件，会报“模型配置 缺少或无效”并以非零状态结束；升级本身已经完成，再运行一次（已是新版的）`scripts/ops/ops.sh doctor` 复查即可。

机器人容器平时使用 host 网络；rootless 下 host 网络只是 rootlesskit 的网络命名空间，宿主机、平台回调和隧道都连不到，所以部署改为把端口发布到原监听地址（直连为 `0.0.0.0`，隧道为 `127.0.0.1`），容器内监听所有接口。来源 IP 仍由宿主机防火墙在该端口上限制。发布端口的是以部署用户身份运行的 rootlesskit，低于 `net.ipv4.ip_unprivileged_port_start`（通常 1024）的端口默认发布不了：首次部署的默认端口因此改为 `11011`，输入或已保存的低端口会在停机前被拒绝，并提示改用高端口，或调低该内核参数、给 rootlesskit 加 `CAP_NET_BIND_SERVICE` 后重试；升级沿用的低端口同样在停机前停止。rootless 下机器人容器和外链管理的一次性容器都访问不到只监听宿主机 `127.0.0.1` 的服务（例如本机的 MinIO 或本地模型接口），监听非回环地址的服务可以用宿主机的该地址访问。启用 SELinux 强制模式的主机尚未验证。

基础组件通过官方渠道安装：[Bun](https://bun.sh/docs/installation)、[uv](https://docs.astral.sh/uv/getting-started/installation/)、[Docker Engine（Debian）](https://docs.docker.com/engine/install/debian/)。

Cloudflare 模式会自动将官方 `cloudflared` 下载到项目根目录（Windows 为 `cloudflared.exe`，Linux 为 `cloudflared`），校验 SHA-256 后使用；已有可运行的根目录副本会直接复用。域名需先接入 Cloudflare DNS 并激活，再配置机器人子域名和隧道公开路由。隧道 token 从 Cloudflare 控制台获取，部署时可直接粘贴 token、填写文件路径，或预先保存到 `data/config/cloudflared-token` 后留空读取。输入会隐藏，默认输入与运行凭据统一使用这个文件。完整步骤见[隧道托管](operations.md#隧道托管)。

部署完成后，可在 `bun run tui` 的 **系统 → 服务部署 → 更新 cloudflared** 主动更新到官方稳定版；先下载校验，再替换并恢复隧道原运行状态，失败恢复旧程序。首次安装的版本清单与这个主动更新入口分别维护，详见[更新 cloudflared](operations.md#更新-cloudflared)。

### Python 与文档预览

Python 小版本范围固定为 `>=3.14,<3.15`，补丁版本由 uv 选择；依赖及传递依赖由 `uv.lock` 锁定。Windows 和 Docker 默认都使用 `<群目录>/venv/`，每群独立、首次使用时按需 `uv sync`；不会自动使用项目根目录 `.venv`。各群依赖从下载缓存复制安装，避免硬链接导致原地修改相互影响；基础 Python 解释器和下载缓存可以共用。

仅管理员显式配置 `BOT_DOCUMENT_ENV` 时，所有群才共用指定环境。TUI「设置 → 高级运行参数 → 文档与诊断」中的「共享文档环境覆盖」留空或恢复默认，即为每群独立。Docker 镜像里的 `/app/.venv` 用于构建验证和显式选择，不替代群 venv。群 venv 缺失或与当前配置不一致时由 uv 按需准备，因此该群首次使用文档功能可能需要联网下载 Python 和依赖。生成文件保留在用户 tmp，venv 只存工具依赖。

通常无需手工同步。需要预热某个群时，停止服务，在项目根目录执行（将路径换成实际群目录）：

```powershell
$env:UV_PROJECT_ENVIRONMENT = (Join-Path $PWD 'data/groups/<group>/venv')
uv sync --locked --no-dev --no-install-project
if ($LASTEXITCODE -eq 0) {
    bun scripts/runtime/document-manifest.ts . $env:UV_PROJECT_ENVIRONMENT
}
Remove-Item Env:UV_PROJECT_ENVIRONMENT
```

Linux 的同等操作为 `UV_PROJECT_ENVIRONMENT=/absolute/group/venv uv sync --locked --no-dev --no-install-project`，成功后运行 `bun scripts/runtime/document-manifest.ts . /absolute/group/venv`。marker 只记录预期配置，运行时仍验证实际解释器、依赖及导入。

Windows 若需 Word/PPT 预览，从 [LibreOffice 官网](https://www.libreoffice.org/download/download-libreoffice/)安装。在 TUI「设置 → 高级运行参数 → 文档与诊断」的「LibreOffice 程序路径」中填写程序的绝对路径，例如 `C:/Program Files/LibreOffice/program/soffice.exe`；便携版填写其 `program/soffice.exe` 的绝对路径。留空时先从服务账户的 PATH 查找 `soffice`、`libreoffice`，Windows 再查标准安装目录。Linux 同样可设置，如 `/usr/bin/soffice`；隔离任务须填写任务容器内已存在的程序路径，Docker 镜像预装 LibreOffice，通常保持自动查找即可。指定路径无效时会报错，请修正或恢复自动查找。变更后重启服务。PDF 预览直接使用 Python 库。预览字体取自运行主机，建议安装与客户模板一致的字体；Docker 提供 Noto CJK。缺少 LibreOffice 时仍可编辑和组装文件，工具会明确报告未完成视觉检查。

只读 Docker 容器需要可写的 `/tmp`，例如 `--tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777`；部署脚本已提供该挂载。LibreOffice 的 Unix 进程通信文件使用 `/tmp`，仅设置 `TMPDIR` 无法代替它。每次转换的 LibreOffice 用户配置（profile）放在系统临时目录下单独创建的目录（容器内即该 `/tmp`），任务结束、失败或取消后删除，文档工具同时最多两次转换；缓存和输出放在本次任务临时目录。Windows 上 profile 目录较深时曾出现 LibreOffice 退出码为 0 却不生成 PDF，因此不放在群目录下，服务账户的 TEMP 也应保持较短路径。转换错误会保留 LibreOffice 的诊断输出。

## 执行部署

先获取代码，再进入项目目录：

```sh
git clone https://github.com/jaykwok/mixin-chatbot.git
cd mixin-chatbot
```

在项目根目录选择对应入口。脚本会引导模型与入口配置、生成 webhook 密钥、保存运行设置并检查新实例。

Windows，在管理员 PowerShell 中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/deploy.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ops/ops.ps1 doctor
```

Linux / Docker：

```sh
bash scripts/deploy/deploy.sh
bash scripts/ops/ops.sh doctor
```

首次部署直接创建当前存储结构。后续重复部署时，脚本先暂停已有实例并保存配置、启动定义、依赖或镜像及原运行状态，停止时明确提示“已停止机器人服务”；Windows 与 Docker 都在停止前问完端口、入口模式、域名、是否重新配置 AI、未托管 Cloudflared 的归属及缺失的隧道 token，取消不会改动部署，只有 AI 向导因依赖重装或新镜像而在停止后运行。停止后不再追问：隧道连接器只启动一次，启动失败或期间出现未确认的 Cloudflared 时直接回滚，重新部署时再确认。部署失败会尝试回滚，恢复失败则保留现场并报错。部署被强制中断或回滚未完成时，重新运行部署脚本会先显示上次操作的记录，询问继续还是回滚；继续只使用停机前确认的设置，数据已提交时只能继续，详见[中断恢复](operations.md#中断恢复)。Windows 计划任务优先使用 S4U 开机启动，受系统限制时回退到登录启动，并显示实际方式。

## 配置平台入口

生产回调地址为 `/webhook/<secret>`，密钥由部署脚本生成并保存在 `data/config/webhook-secret`，格式为 64 位十六进制。

| 入口模式 | 配置要点 |
| --- | --- |
| 直连 | 只放行项目配置的平台来源 IP；可通过 `PLATFORM_IP` 指定 |
| Cloudflare | 应用绑定回环地址；Published application 指向 `http://127.0.0.1:<BOT_PORT>`，域名和 WAF 由部署方配置 |

把脚本输出的完整回调地址填到 IM 平台；每个群使用独立的 callback key（平台回调标识），不要跨群共用。

部署后按以下顺序验证：

1. 结合实际域名运行 `doctor`，检查配置、服务和网络入口。
2. 在测试群 @ 机器人，发送“只回复 OK”，确认收到回答。
3. 将资料同步到该群的 `workspace/`，再请求查找资料、发送文件，并验证 `/status` 和 `/stop`。目录位置见[数据目录](#数据目录)。

本地 `/health` 只能确认应用就绪；收到群内回复和文件后，才完成实际交付验证。

<details>
<summary>Cloudflare 规则维护</summary>

Cloudflare 入口应采用默认拒绝、显式放行的策略。实际规则在 Cloudflare 控制台维护，部署脚本不会同步；以控制台当前配置为准。

新增或修改 `src/server/http-app.ts` 的公网路由时，必须同时检查控制台中的放行路径、HTTP 方法和来源条件，并同步所需规则。仅提交路由代码不足以开放公网访问。验收应分别检查本地源站响应和公网请求；如果本地正常而公网失败、源站日志全空，先查 Cloudflare 安全事件及规则命中情况，不要仅凭应用日志判断请求没有发出。

</details>

错误或缺失 webhook 密钥、未知路由、管理 token 错误对外保持相同的 `404 / Not Found`；已通过密钥校验的请求保留实际状态码。拒绝日志的分类、计数与脱敏规则见[运维手册](operations.md#http-拒绝日志)。

## 模型配置

先停止已有服务，再运行 `bun run configure`；保存后重启并执行 `doctor`。没有宿主机 Bun 的 Docker 部署可重新运行部署脚本，在提示时选择重新配置 AI。

模型配置全部落在 Pi 自己的两个文件里，格式和校验都归 Pi：`data/config/models.json` 声明服务商、凭证和模型，`data/runtime/pi/settings.json` 记录选中的服务商、模型和推理级别（Pi 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`）。每个实例固定用一个模型，不在运行中切换。`bun run configure` 提供两种方式：

- **Pi 内置服务商**：从支持 API Key 的服务商中选择、填 Key，再从刷新后的目录选模型。地址、协议、工具兼容和模型能力由 Pi 随包目录或服务商动态目录提供，不复制到 `models.json`。同一厂商的不同站点、区域或套餐可能使用不同服务商 ID，请按实际账号选择；可选项以向导当前列出的为准。
- **自定义服务商**：填 provider id、协议、地址和 Key，向导按端点自己返回的清单（OpenAI 兼容为 `GET {baseUrl}/models`）列出模型供选择；端点列不出来时退回手填 id。选中的 id 若在 Pi 目录里有同名模型，上下文、能力和价格会用它预填，由你核对后落盘——中转站的实际价格和限制可能与原厂不同。协议选项来自 Pi 已注册的 api 实现。

内置方式的最小 `models.json` 只需凭证：

```json
{
  "providers": {
    "YOUR_PROVIDER_ID": { "apiKey": "YOUR_API_KEY" }
  }
}
```

`apiKey` 也可以写成 `$ENV_VAR`、`${VAR}` 或 `!command`，由 Pi 解析。实例不读取磁盘 `auth.json`，凭证统一从 `models.json` 接入。向导保留服务商的 `headers`、`compat`、`authHeader`、`modelOverrides`，以及同一端点、同一模型上未询问的原生字段（如模型级 `headers`、`thinkingLevelMap`、`samplingParams`）。向导在暂存目录中完成配置和校验，取消时保留当前配置，提交失败会恢复原文件。

旧模型配置直接按[重新配置说明](operations.md#重新配置模型)重建；运行时不维护旧顶层选型字段的迁移逻辑。后续换模型或凭证继续运行 `bun run configure`，所选推理级别会同步清除该模型原有的级别覆盖。

## 配置与数据

### 运行设置

优先级：**显式环境变量 > `data/config/runtime.json` > 代码默认值**。

Pi Durable 的引擎策略独立保存在 `data/runtime/pi/settings.json`；原生预算、上下文缓存和可选辅助模型、MCP 的配置方式见[运行设置与可选工具](runtime-tools.md)。跨数据版本升级时重新配置，见[自动重置升级](data-migrations.md)。

部署脚本保存支持的设置，未显式指定的值沿用已存配置。仅在前台启动时设置环境变量不会自动落盘；停机后可运行 `bun run configure-runtime` 保存当前支持项。配置文件中的未知键、无效类型及越界值会阻止启动。

日常调整可进入 **系统 → 设置 → 高级运行参数**，按“并发与附件、超时与退出、缓存与索引、文档与诊断”选择，共 17 项。Enter 修改，`d` 恢复选中项的默认值，`s` 预览并保存；默认值与机器人运行时共用定义。Esc 返回保留当前草稿，退出 TUI 前会提醒尚未保存的修改。端口、监听地址和群数据目录仍通过服务部署设置。

确认后才短暂停止运行中的机器人，保存并通过健康检查后恢复；原本停止的实例保持停止。应用或健康检查失败时尝试恢复原配置；并发修改不会被覆盖。界面显示的是保存值与默认值，环境变量仍有更高优先级：保存前检查 Windows 当前环境或 Linux 容器的相关覆盖，发生冲突时拒绝写入；自定义计划任务还需检查其启动环境。

| 设置 | 默认值 | 范围 / 说明 |
| --- | --- | --- |
| `BOT_PORT` | 1011（rootless Docker 不能发布低端口时为 11011） | 1–65535 |
| `BOT_HOST` | 0.0.0.0 | IP 或 localhost；Cloudflare 部署设为 127.0.0.1 |
| `GROUP_DATA_ROOT` | data/groups | 可指定其他磁盘；容器自定义目录映射为 /app/group-data |
| `BOT_DEBUG` | 0 | 0/1；开启后记录用户消息正文 |
| `BOT_MAX_ACTIVE_REQUESTS` | 32 | 1–1000，普通请求总量 |
| `BOT_BASH_TIMEOUT` | 600 秒 | 10–3600 秒；工具可声明其他时限，最高 3600 秒 |
| `BOT_RUN_TIMEOUT_SECONDS` | 1200 秒 | 10–7200 秒，覆盖准备、模型、工具与最终交付 |
| `BOT_MODEL_IDLE_TIMEOUT_SECONDS` | 180 秒 | 10–7200 秒；模型等待或输出期间连续无有效进展的上限 |
| `BOT_MODEL_RESPONSE_TIMEOUT_SECONDS` | 600 秒 | 10–7200 秒；单次模型响应的上限，持续输出也不续期 |
| `PI_CACHE_RETENTION` | short | Pi 原生 short/long，服务商决定实际期限；不提供全局 none。Durable 引擎不做缓存保温 |
| `BOT_ATTACHMENT_CONCURRENCY` | 2 | 1–8；在小附件读取前预约，覆盖读取与上传，限制内存峰值 |
| `BOT_DELIVERY_TIMEOUT_SECONDS` | 180 秒 | 1–600 秒，包含出站排队和重试 |
| `BOT_SHUTDOWN_TIMEOUT_SECONDS` | 20 秒 | 5–25 秒，覆盖 HTTP、任务、进程与租约收尾 |
| `BOT_INDEX_TTL_MINUTES` | 5 分钟 | 1–1440 分钟，活跃会话每轮检查 |
| `BOT_INDEX_MAX_FILES` | 50000 | 100–1000000 |
| `BOT_INDEX_MAX_DEPTH` | 12 | 1–64 |
| `BOT_DOCUMENT_ENV` | 每群独立 venv | 留空使用本群 venv；显式填写才让所有群共享指定环境 |
| `BOT_DOCUMENT_WORK_ENABLED` | `1` | 文档加工模块开关；`0` 同时关闭 skill、六个文档编辑、生成与预览工具及模块提示词，重启生效；基础解析和发文件保留 |
| `BOT_DOCUMENT_PPTX_TEMPLATE` | 未设置（内置版式） | `.pptx`/`.potx`；生成 PPT 未指定模板时套用，见下文 |
| `BOT_DOCUMENT_DOCX_TEMPLATE` | 未设置（内置版式） | `.docx`/`.dotx`；生成 Word 未指定模板时套用，见下文 |
| `BOT_DOCUMENT_OFFICE_PATH` | 未设置（自动查找） | LibreOffice 程序的绝对路径；Windows/Linux 均支持，隔离任务填写任务容器内路径，重启生效 |

### 默认文档模板

`BOT_DOCUMENT_PPTX_TEMPLATE`、`BOT_DOCUMENT_DOCX_TEMPLATE` 在 TUI「设置 → 高级运行参数 → 文档与诊断」中分别为「默认 PPT 模板」「默认 Word 模板」，应用后重启生效。机器人用 `document_build` 生成文档且没有指定模板时套用它们；用户或机器人指定了其他文件时以指定的为准。

- 相对路径（如 `模板/公司.potx`）在各群自己的 `workspace` 中查找，不能含 `..`，也不能经链接指向 workspace 之外。某群没有这个文件时，该群照常使用内置版式，并在工具结果中提示，不报错。适合各群使用不同模板。
- 绝对路径所有群共用同一份文件。Windows 直接填文件路径；Linux Docker 填容器内路径，例如放在宿主机 `data/templates/公司.potx`，填写 `/app/data/templates/公司.potx`。
- 支持普通文档（`.pptx`/`.docx`）和 Office 模板（`.potx`/`.dotx`）。Office 模板在本次生成的临时副本中转换后使用，原文件不变。PPT 模板中有封面、封底等样例页时，可在对话中要求保留（`keepSlides`）；只含母版和版式的 `.potx` 仍能生成，标题样式按版式推断，首次使用建议看一下渲染效果。

### 数据目录

当前格式只保存新一代 Durable 群库。跨数据版本更新按[自动重置升级](data-migrations.md)保留统计 schema 2 与入口凭证，重新配置并清理旧会话及群资料；普通更新沿用原数据。

```text
data/
├── config/
│   ├── models.json            Pi 原生服务商、凭据与模型定义
│   ├── runtime.json           持久运行设置
│   ├── webhook-secret         入站鉴权密钥
│   ├── relay.json             可选大文件分发配置
│   ├── auxiliary.json         可选分类、图片模型引用与并发预算
│   ├── mcp.json               可选 MCP 服务器、传输与工具白名单
│   └── cloudflared-token      隧道 token：默认输入与运行共用，直接粘贴时自动保存
├── state/
│   ├── agent.sqlite           待交付内容、路由隔离与路径身份
│   ├── relay.sqlite           远端对象的持久账本
│   ├── data-version.json      项目数据版本与迁移事务号
│   ├── release-data.json      当前发布的验证/提交状态
│   ├── instance.json          实例 PID、启动时间与关闭令牌
│   └── ...                    部署状态与维护租约
├── runtime/
│   ├── pi/settings.json       Pi 选型与 Durable 原生运行策略（需备份）
│   ├── mcp/                   可选 MCP OAuth 凭证（按秘密配置备份）
│   ├── models-store.json      模型目录缓存，动态目录服务商离线启动时需要
│   └── ...                    其余 Pi 资源与启动脚本，可重建
└── groups/
    ├── data-version.json      群根数据版本，与项目侧成对保存
    ├── stats.sqlite           使用统计账本：独立于会话历史，清空上下文不影响统计
    └── <group>/
        ├── durable.sqlite     群库（Pi Durable）：成员的会话、排队消息、控制命令与运行记录（另有 -wal 等，需一起备份）
        ├── workspace/         外部同步的资料源
        ├── index/             materials.md、扫描 manifest；可选 ignore.txt、parsed/ 文档缓存
        ├── venv/              原生部署按需准备的解析环境
        └── users/<user>/
            └── tmp/           生成文件、缓存与完整工具输出
backup/                        为了能撤销某个操作而留的；清理用 backup-scan / backup-clean，别手动删
├── snapshots/                 部署、升级与连接器安装的回滚现场
├── statistics/                跨代重置前的独立统计快照及核对摘要，成功后继续保留
└── rm/                        被移除的旧文件、会话与用户 tmp；操作期间的归档在 rm/<快照名>/
tmp/                           报告、测试隔离 cwd、诊断产物、一次性脚本；无任务使用时可清理
├── reports/                   TUI 导出的离线 HTML 报表
└── backup-cleanup/             历史归档清理的清单和执行结果
logs/                          应用日志与可选的隧道日志
```

群和用户标识会编码为安全目录段；映射到已有目录的大小写别名会被拒绝，避免 Windows 串会话。将资料同步到对应群的 `workspace`，生成物写入各用户的 `tmp`。

历史、统计和临时目录命令支持 `--group-id`（原始群号）或 `--storage-segment`（已编码目录段），两者互斥；PowerShell 包装器对应 `-GroupId` / `-StorageSegment`。未指定时自动判断，遇到两个不同群同时匹配则拒绝操作。TUI 会传入明确的目录段。

建议正常停机后备份整个 `data/`，并单独备份外置的 `GROUP_DATA_ROOT`。`data/runtime/pi/settings.json` 是必须保留的模型选型；`data/runtime/models-store.json` 也应随配置备份，动态目录服务商依赖它离线启动，移除后需重新运行向导联网刷新。SQLite 使用 WAL，运行中只复制主 `.sqlite` 文件可能遗漏数据。

群库和群目录里的结果文件必须作为同一批数据备份；只有数据库不能恢复图片、附件或全文。停机后可运行 `bun scripts/ops/data-backup.ts backup <新目录>`：取得维护租约、检查并 checkpoint 所有数据库，再复制状态和群目录，写入逐文件 SHA-256 清单。配置、密钥、模型目录缓存和选型仍需另行备份。恢复命令 `bun scripts/ops/data-backup.ts restore <备份目录> <空暂存项目> [空群数据根]` 先验证全部摘要，再复制到空目录并检查 SQLite；配置补齐后运行 `bun scripts/runtime/data-current.ts validate --project <暂存项目> --groups <暂存群根>`，验收通过再切换数据根。恢复工具不会覆盖正在使用的数据。

Windows 启动器对非零退出等待 60 秒后启动新进程，最多重试 999 次，正常退出不重试；停止机器人也会停止启动器。此退避让旧群租约有时间过期。修改代码后需按正常部署流程更新启动器；运行中的服务不会自动切换到这份代码。

### 大文件外链配置

超过 25 MiB 的本地文件可上传到兼容 S3 的私有存储桶，通过限时预签名 URL 分发。接收者直接从对象存储下载，不经过机器人或 Cloudflare 隧道。未配置时，超限文件仍报错。

运行 `bun run tui`，进入 **系统 → 设置 → 外链配置**，填写 S3 服务端点、区域、桶名和专用访问凭据。向导支持桶名在域名中（Virtual hosted）和桶名在路径中（Path style）两种寻址方式；凭据隐藏输入，同一端点和账号可留空沿用。保存前显示预览，确认后才短暂停止并恢复原本运行的机器人；取消不修改配置和服务。Windows 前台实例没有计划任务时，须先停止实例。

默认单文件上限 **2 GiB**，下载授权 **2 小时**，到期后另留 **30 分钟**删除余量。对象默认直接放在桶根目录，路径为 `日期-uuid/原文件名`。高级设置可改放到子目录（清空即回到根目录），并调整上限、下载期限和删除余量。上传使用单次 PUT，配置上限不能超过 5 GiB，不使用分片上传。下载有效期最多 168 小时，删除余量为 1–1440 分钟；临时凭据可能早于链接到期，需要自行更新。

也可手工配置 `data/config/relay.json`，重启后生效。以下为阿里云 OSS S3 兼容端点示例，凭据和桶名需替换：

```json
{
  "provider": "s3",
  "endpoint": "https://s3.oss-cn-hangzhou.aliyuncs.com",
  "region": "cn-hangzhou",
  "bucket": "your-private-bucket",
  "accessKeyId": "替换为专用访问密钥 ID",
  "secretAccessKey": "替换为专用访问密钥",
  "prefix": "",
  "forcePathStyle": false,
  "maxBytes": 2147483648,
  "expireHours": 2,
  "cleanupGraceMinutes": 30
}
```

`endpoint` 填**不含桶名、路径或查询参数的服务端点**，须能被机器人和接收者访问；例如腾讯 COS 填 `cos.ap-chengdu.myqcloud.com`，不要填控制台显示的桶域名。Virtual hosted 下端点以桶名开头时配置会被拒绝，向导会提示改正，并按腾讯 COS、AWS、R2 的端点预填区域。向导省略协议时补 HTTPS；生产环境使用 HTTPS，本地 MinIO 可显式填 `http://127.0.0.1:9000` 并设 `forcePathStyle: true`。可选 `sessionToken` 用于临时凭据。`prefix` 省略或为空时对象放在桶根目录；填 `relay/` 等目录时放在该目录下。不要把凭据写入地址或群消息。

适配使用通用 S3 Signature V4 的 PUT、HEAD、GET 和 DELETE。具体云厂商、区域、资源池须支持这四项操作和预签名查询参数，不能把“支持部分 S3 API”视为所有能力均已验收：

| 服务 | 配置依据 |
| --- | --- |
| 阿里云 OSS | 使用带 `s3.oss-` 的兼容端点，通常使用 Virtual hosted，见[官方 AWS SDK 接入说明](https://help.aliyun.com/zh/oss/developer-reference/use-aws-sdks-to-access-oss) |
| 腾讯云 COS | 桶名包含 APPID，端点、区域及签名兼容范围见[官方 S3 配置说明](https://intl.cloud.tencent.com/document/product/436/34688?lang=en) |
| 天翼云 | 按具体产品和资源池填写端点、区域及寻址方式；经典版 I 型的 [V4 预签名文档](https://www.ctyun.cn/document/10026693/10027130)说明了查询参数认证，其他产品请核对各自文档 |
| Cloudflare R2 / MinIO / AWS S3 | 按服务文档设置 endpoint、region、bucket 和寻址方式；R2 通常使用 region `auto` |

必须先在云端准备专用**私有桶**，关闭公共读取及任何绕过签名的公开域名，凭据只授予分发对象所需的读、写、删除权限：使用根目录时授权范围是整个专用桶的对象，配置了 `prefix` 时只授权该目录。机器人不会自动修改桶权限。收到 URL 的任何人在有效期内都能下载，预签名 URL 本身就是临时授权，不能限制为特定群成员，也不能撤回已经下载的副本。

两个期限分别持久化：上传完成并经 HEAD 核验大小后，记录 `expiresAt`（下载到期）与 `deleteAfter`（下载到期加余量）。上传前先登记唯一对象路径 `日期-uuid/原文件名`（配置了 `prefix` 时位于该目录下），网络失败或进程中断也不会丢失回收依据。成功、失败或取消后的本地快照都会删除。

相同后端、内容和文件名仅在剩余期限不少于当前配置的 90% 时复用（默认至少 108 分钟）；不足时，新分享上传到新的唯一对象路径并获得完整期限。旧对象仍保留原下载期限和删除余量；查看列表、待交付补发或修改配置都不延长旧期限。群消息显示北京时间（UTC+8）的到期时刻。

上传成功后无法核验大小时不发链接。旧对象探测返回 404 或 403 时，新分享改用新路径上传，必须完成 PUT 和上传后的严格 HEAD 核验才发送链接，不覆盖旧路径；其他服务器或网络错误直接报错并保留记录。AWS 在没有 ListBucket 权限时也会用 403 表示对象不存在，不能把它一律解释成密钥错误，见 [HeadObject 权限说明](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)。上传、核验和删除请求的签名在请求超时之外增加 5 分钟余量，仍需保持系统时钟同步；下载签名期限不增加这份余量。

服务启动时扫描，随后每 5 分钟尝试清理到达 `deleteAfter` 的对象；扫描不会与自身重叠，也不等待会话或统计维护。删除成功或确认对象不存在才移除账本，失败下轮重试。因此计划时间不是物理删除的精确时刻；长下载、网络故障和停机都不能保证届时文件已删除。未完成上传超过上传预算加一分钟后可被回收（默认 31 分钟）。

云端应再设覆盖分发对象的生命周期作为停机/账本丢失兜底：根目录布局覆盖整个专用桶，配置了 `prefix` 时只覆盖该目录。默认设置可使用一天或更长的保留期；实际规则必须长于上传预算、下载期限和删除余量之和。生命周期通常按天或异步处理，不能代替两小时下载签名。专用临时桶应关闭版本控制、对象锁及复制；已有历史版本需单独处理，否则普通 DELETE 可能只创建删除标记，旧版本仍占空间。参见 [S3 预签名有效期](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)、[S3 版本化删除](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html)和 [R2 生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。

停用会归档配置并保留账本、远端文件，同时停止机器人的清理。切换端点、区域、桶或目录前应先在原配置下清空在册对象；向导保存前会提示不属于新设置的在册数量。新后端不会删除旧后端对象，后台每次运行对同一旧后端仅告警一次；可切回原配置清理，或在云端处理。doctor 的 S3 项只检查必填项，显示通过不代表云端权限、私有访问及签名已验收；修改配置或云端设置后，请在 **数据 → 外链 → 测试外链**（或 `bun run relay test`）上传测试文件确认，见[测试外链](operations.md#测试外链)。

## 数据版本与升级

当前应用数据版本为 6，Pi 精确锁为 1.3.0。update 以成对数据版本判断：相同则正常升级；较旧版本在停机前提示重置并重新配置，然后原样保留并核对现有统计账本、保存统计快照、清理旧会话及未入账消息并切换，不再补算。统计 schema 2 和 webhook / Cloudflare 入口凭证原样保留，旧格式不进入新运行时。标记损坏、不成对或数据比程序更新时拒绝清理。提交前只验证实例不处理业务，失败可回滚；完整步骤和首次升级入口见[自动重置升级](data-migrations.md)。

## 任务隔离部署

Linux Docker 的新部署和升级需要与服务宿主 UID 匹配的本机 rootless Docker daemon，用于执行 bash、文档处理与解析。rootless 服务可复用自己的 daemon；rootful 服务沿用原数字 UID/GID，首次部署默认 UID 1001，因此需要属于 UID 1001 的 rootless socket。默认位置是 `/run/user/<UID>/docker.sock`，首次配置可通过 `BOT_TASK_DOCKER_HOST=unix:///绝对路径/docker.sock` 指定。脚本在停机前检查 socket 属主、daemon 身份、固定镜像与路径映射；缺少条件时停止，不安装 daemon、不改变服务身份或自动 sudo。

部署把同一不可变镜像同步到任务 daemon，并保存 `data/state/task-runtime` 和私有的 `data/config/task-deployment.json`。控制面获得 socket；任务容器只获得自己的可写目录及只读输入，使用 `--network none`。升级提交后按快照中的固定容器 ID 撤销旧业务容器，确认其不能被迟到的启动请求重新启动后才恢复业务。不能手工改映射或换 daemon 绕过检查：原回执绑定旧映射，须先在原环境中完成处置。

每次 bash 的 `PI_USER_TMP` 是新任务目录。要读之前的临时产物，在 `input_paths` 中显式列出；workspace 和资料索引仍只读可见。Windows 原生部署不隔离 bash，工具说明里也不出现隔离提示和 `input_paths` 参数。输入继续受单文件 128 MiB、总计 256 MiB 和 20000 条目限制，无关的历史 tmp 不再进入快照。隔离文档使用镜像内 `/app/.venv`；每个工作容器的 Office profile 位于自身 `/tmp`，工作容器退出并撤销后释放，不在服务容器的 64 MiB `/tmp` 中累积。

隔离模式下 `send_image`、`send_file` 只下载公网 HTTP(S) 地址：拒绝私网、回环、链路本地、特殊用途地址、带凭据的 URL 和所有重定向；DNS 全部结果通过后固定连接地址。需要下载跳转后的资源时应提供最终公网地址。管理端模型、MCP 与已配置的外链后端仍属于可信控制面。
