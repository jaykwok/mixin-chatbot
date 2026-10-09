# 部署与配置

[返回 README](../README.md) · [管理台指南](tui.md) · [运维手册](operations.md)

首次部署按“选择部署方式 → 执行部署 → 配置平台入口”完成，再同步群资料并验证。日常调整优先使用向导；后半部分的配置表和目录说明用于查阅。

**首次部署**：[环境要求](#选择部署方式) · [执行部署](#执行部署) · [平台入口](#配置平台入口)

**配置参考**：[模型配置](#模型配置) · [运行设置](#运行设置) · [数据目录与备份](#数据目录) · [大文件外链](#大文件外链配置)

## 选择部署方式

| 方式 | 主机要求 | 文档解析环境 |
| --- | --- | --- |
| Windows 原生 | Bun 1.4.2+、Git for Windows 的 GNU Bash、原生 `uv.exe`；管理员 PowerShell 部署 | Python 3.14 群 venv 按需准备；Word/PPT 预览另需 LibreOffice |
| Linux / Docker | glibc Linux、Git、Docker Engine、Bash、curl、coreutils、util-linux 的 `flock`；rootful Docker 由 root 部署和升级，rootless Docker 由其所属用户部署；直连模式需要 UFW 及 root / sudo 权限 | 镜像预装 Python 3.14、锁定的文档库、LibreOffice 和中文字体 |

Linux 工具进程监督需要访问 `/proc`；不支持 macOS、Alpine/musl。Docker 的配置向导与应用运行在镜像内，宿主机无需额外安装 Bun；若使用[运维界面](tui.md#运维界面)，则需在宿主机安装 Bun 1.4.2+。

rootful Docker（以 root 运行的默认安装）下，部署、升级、继续和回滚都要由 root 执行，例如 `sudo bash scripts/deploy/deploy.sh`：只有 root 能完整查看镜像存储所在磁盘的剩余空间，并按服务的身份给新建的文件设置属主。docker 组中的普通用户会在任何提问、构建和停机之前被拒绝，脚本不会自动 sudo。rootless Docker 由它所属的普通用户运行，不要用 sudo。

容器进程的身份：真正的首次部署时，root 部署的容器降权到 UID/GID 1001，并把挂载目录的属主改成它；rootless Docker 下以容器内的 root 运行，它映射回宿主机上的部署用户，所以挂载目录仍归这个用户。之后的重新部署和升级沿用原容器 `mixin-chatbot`（运行或停止均可）的数值 UID/GID：停机前从原容器读取并核对，写入本次事务的快照，预览、迁移、验证实例、正式实例以及中断后的继续和回滚都用它；只给本次新建的目录和文件设置属主，不批量改已有数据的属主。原容器的身份不能可靠确定时（不是数值 UID:GID、数据目录不是本项目的、与 Docker 的模式不符），部署和升级在停机前停止，不猜测。原容器已被删除但部署过时，重新部署按 `data/state` 的属主提出身份，经确认后才使用；升级要求原容器存在。以前由 docker 组普通用户部署的实例改由 root 升级后，服务仍以原来的 UID/GID 运行。检出属于那个用户，git 拒绝以 root 操作它（仓库中的钩子和配置会以 root 运行）：确认信任这份检出后，由 root 执行一次 `git config --global --add safe.directory <项目目录>`，脚本不会代为加入；此后 root 升级时写入检出的文件属于 root。用旧版 `ops.sh update` 第一次这样升级时，升级完成后旧入口自带的体检仍按旧规则以 1001:1001 运行一次性容器校验模型配置，读不了服务身份的配置文件，会报“模型配置 缺少或无效”并以非零状态结束；升级本身已经完成，再运行一次（已是新版的）`scripts/ops/ops.sh doctor` 复查即可。

机器人容器平时使用 host 网络；rootless 下 host 网络只是 rootlesskit 的网络命名空间，宿主机、平台回调和隧道都连不到，所以部署改为把端口发布到原监听地址（直连为 `0.0.0.0`，隧道为 `127.0.0.1`），容器内监听所有接口。来源 IP 仍由宿主机防火墙在该端口上限制。发布端口的是以部署用户身份运行的 rootlesskit，低于 `net.ipv4.ip_unprivileged_port_start`（通常 1024）的端口默认发布不了：首次部署的默认端口因此改为 `11011`，输入或已保存的低端口会在停机前被拒绝，并提示改用高端口，或调低该内核参数、给 rootlesskit 加 `CAP_NET_BIND_SERVICE` 后重试；升级沿用的低端口同样在停机前停止。rootless 下机器人容器和外链管理的一次性容器都访问不到只监听宿主机 `127.0.0.1` 的服务（例如本机的 WebDAV 外链后端或本地模型接口），监听非回环地址的服务可以用宿主机的该地址访问。启用 SELinux 强制模式的主机尚未验证。

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

Windows 若需 Word/PPT 预览，从 [LibreOffice 官网](https://www.libreoffice.org/download/download-libreoffice/)安装，并将 `soffice` 加入服务账户的 PATH；工具也识别 `Program Files/LibreOffice/program/soffice.exe`。使用便携目录时将其 `program` 目录加入 PATH，变更后重启服务。PDF 预览直接使用 Python 库。预览字体取自运行主机，建议安装与客户模板一致的字体；Docker 提供 Noto CJK。缺少 LibreOffice 时仍可编辑和组装文件，工具会明确报告未完成视觉检查。

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

Pi Durable 的引擎策略独立保存在 `data/runtime/pi/settings.json`；原生预算、上下文缓存和可选辅助模型、MCP 的配置方式见[运行设置与可选工具](runtime-tools.md)。升级至数据版本 4 时由迁移工具转换旧引擎设置。

部署脚本保存支持的设置，未显式指定的值沿用已存配置。仅在前台启动时设置环境变量不会自动落盘；停机后可运行 `bun run configure-runtime` 保存当前支持项。配置文件中的未知键、无效类型及越界值会阻止启动。

日常调整可进入 **系统 → 设置 → 高级运行参数**，按“并发与附件、超时与退出、缓存与索引、文档与诊断”选择，共 14 项。Enter 修改，`d` 恢复选中项的默认值，`s` 预览并保存；默认值与机器人运行时共用定义。Esc 返回保留当前草稿，退出 TUI 前会提醒尚未保存的修改。端口、监听地址和群数据目录仍通过服务部署设置。

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

### 数据目录

从 Pi 0.85.1 升级时，配置迁移和版本登记由[升级事务](data-migrations.md)完成；Windows 首次过渡需要按该文档先停机，Docker 首次升级到本版需按该文档运行一次引导命令。[数据版本 3](data-migrations.md#数据版本-3durable-引擎) 把每位成员的会话导入所在群的群库，缓存保温随之关闭。迁移程序随代码发布在 `scripts/migrations/`，升级不依赖 `tmp/` 中的工具。

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
│   ├── migration.json         迁移进度；提交后保留为回执
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
            ├── session.jsonl  数据版本 3 之前的 Pi 会话：已导入群库，原地保留供统计补账
            └── tmp/           生成文件、缓存与完整工具输出
backup/                        为了能撤销某个操作而留的；清理用 backup-scan / backup-clean，别手动删
├── snapshots/                 部署、升级与连接器安装的回滚现场，以及数据迁移快照
├── reports/                   TUI 导出的离线 HTML 报表
├── cleanup/                   历史归档清理的清单和执行结果
└── rm/                        被移除的旧文件、会话与用户 tmp；操作期间的归档在 rm/<快照名>/
tmp/                           测试隔离 cwd、诊断产物、一次性脚本；无任务使用时可清理
logs/                          应用日志与可选的隧道日志
```

群和用户标识会编码为安全目录段；映射到已有目录的大小写别名会被拒绝，避免 Windows 串会话。将资料同步到对应群的 `workspace`，生成物写入各用户的 `tmp`。

历史、统计和临时目录命令支持 `--group-id`（原始群号）或 `--storage-segment`（已编码目录段），两者互斥；PowerShell 包装器对应 `-GroupId` / `-StorageSegment`。未指定时自动判断，遇到两个不同群同时匹配则拒绝操作。TUI 会传入明确的目录段。

建议正常停机后备份整个 `data/`，并单独备份外置的 `GROUP_DATA_ROOT`。`data/runtime/pi/settings.json` 是必须保留的模型选型；`data/runtime/models-store.json` 也应随配置备份，动态目录服务商依赖它离线启动，移除后需重新运行向导联网刷新。SQLite 使用 WAL，运行中只复制主 `.sqlite` 文件可能遗漏数据。

群库和群目录里的结果文件必须作为同一批数据备份；只有数据库不能恢复图片、附件或全文。停机后可运行 `bun scripts/ops/data-backup.ts backup <新目录>`：取得维护租约、检查并 checkpoint 所有数据库，再复制状态和群目录，写入逐文件 SHA-256 清单。配置、密钥、模型目录缓存和选型仍需另行备份。恢复命令 `bun scripts/ops/data-backup.ts restore <备份目录> <空暂存项目> [空群数据根]` 先验证全部摘要，再复制到空目录并检查 SQLite；配置补齐后运行 `bun scripts/migrations/validate.ts`，验收通过再切换数据根。恢复工具不会覆盖正在使用的数据。

Windows 启动器对非零退出等待 60 秒后启动新进程，最多重试 999 次，正常退出不重试；停止机器人也会停止启动器。此退避让旧群租约有时间过期。修改代码后需按正常部署流程更新启动器；运行中的服务不会自动切换到这份代码。

### 大文件外链配置

超过附件上限的本地文件可通过 WebDAV 分发。外链是可选功能，部署向导只提示入口；需要时运行 `bun run tui`，进入 **系统 → 设置 → 外链配置**。已生成外链的查看与清理位于 **数据 → 外链**。

向导可启用、修改或停用外链。填写 WebDAV 上传目录、对应的公开下载目录，以及可选的用户名和密码；密码隐藏输入，同一地址和账号的密码可留空沿用。文件上限、有效期和 [OpenList](https://github.com/OpenListTeam/OpenList) 兼容签名放在可选的高级设置中，跳过时保留已有设置，新配置默认上限 2 GiB、不自动过期、不使用签名。

向导内提供 [OpenList](https://github.com/OpenListTeam/OpenList) + Cloudflare 子域名示例：上传地址填写到 [OpenList](https://github.com/OpenListTeam/OpenList) 挂载目录，例如 `127.0.0.1:5244/dav/relay`，此处挂载目录为 `relay`。公开下载项只填 `files.example.com` 即可推导为 `https://files.example.com/d/relay/`；也可填写完整下载目录地址。`/dav/` 是 WebDAV 入口，`/d/` 是下载入口，后面的 `relay` 换成实际挂载路径或其子目录。Cloudflare 路由及账号权限见[外链配置示例](operations.md#openlist-与-cloudflare-子域名示例)。

交互输入可省略 `http://`、`https://` 及末尾 `/`。WebDAV 上传地址中的 `localhost`、回环及私有 IP 默认补 `http://`，其他地址（含公开下载）默认补 `https://`；显式填写的协议和下载目录保留，保存预览显示补全后的地址。下载目录只从标准 [OpenList](https://github.com/OpenListTeam/OpenList) 上传路径 `/dav/挂载目录` 推导，支持多级和中文目录；其他后端或反代路径需填写实际公开下载地址。上传地址填写到挂载目录，不带日期 UUID 子目录、文件名或签名参数；手写 JSON 时仍填写完整 URL。

保存前会显示配置摘要和到期处理方式。确认后才短暂停止原本运行中的机器人，校验并写入配置，然后恢复运行；原本停止的服务保持停止，取消不会改配置或停机。Windows 以前台方式运行且未安装计划任务时，须先手动停止实例再配置。停用会把配置归档到 `backup/rm`，保留远端文件和账本，同时停止机器人的到期清理。

也可手工配置 `data/config/relay.json`，并重启机器人使其生效：

```json
{
  "webdavUrl": "http://127.0.0.1:5244/dav/relay/",
  "publicBaseUrl": "https://files.example.com/d/relay/",
  "username": "bot",
  "password": "替换为真实凭据",
  "maxBytes": 2147483648,
  "expireHours": 24
}
```

两个 URL 必须对应同一存储目录。示例上限为 2 GiB；未配置外链时，超限文件会报错。

| 配置 | 对象保留规则 |
| --- | --- |
| 不设置 `expireHours` | 保留已上传对象 |
| 设置 `expireHours`，不设置签名 | 按最后复用时间计算闲置期限，到期删除远端对象 |
| 设置 `signSecret` / `signPathPrefix` | 使用项目支持的 HMAC 下载签名；后端必须验证签名，已上传对象保留 |

签名模式中，`expireHours` 控制签名期限，未设置则使用不过期签名。所有模式都会回收超过上传预算的未完成计划。

上传使用有大小上限的不可变快照，让哈希与 PUT 对应相同字节。对象先登记计划，确认上传后更新状态；快照在成功、失败或取消后的收尾中直接删除。相同后端、内容和文件名复用同一对象，布局为 `<日期>-<uuid>/<文件名>`。

缓存探测返回 404/410，或遇到 500、401、网络异常等无法确认的响应时，会在原对象名上尝试 PUT。无法确认时保留原 `uploaded` 状态，避免重传失败后误删已有对象；取消后不再启动补传，操作共享总期限。切换后端后，无法归属当前配置的记录保留供运维处理。

## 数据版本与升级

参见[数据版本与升级事务](data-migrations.md)。业务入口 `src/server/index.ts` 和 TUI 入口在加载配置前检查项目与群根的版本；历史迁移集中在 `scripts/migrations/`。升级由目标版本的升级器执行（Docker 为 `scripts/deploy/upgrade.sh`，由 `ops update` 从目标提交导出后运行），在停机前完成迁移预览和全部确认；提交前仅启动验证实例，提交后恢复正常业务。旧版 `ops.sh` 升级到本版时会被拒绝并打印一次性引导命令，见[第一次升级](data-migrations.md#第一次升级)。
