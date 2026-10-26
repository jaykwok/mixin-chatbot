# 部署与配置

[返回 README](../README.md) · [管理台指南](tui.md) · [运维手册](operations.md)

首次部署按“准备应用机器人 → 选择部署方式 → 执行部署 → 接入开发者后台”完成，再同步共享资料并验证。日常调整优先使用向导；后半部分的配置表和目录说明用于查阅。

**首次部署**：[应用机器人](#应用机器人) · [环境要求](#选择部署方式) · [执行部署](#执行部署) · [接入开发者后台](#接入开发者后台)

**配置参考**：[模型配置](#模型配置) · [运行设置](#运行设置) · [数据目录与备份](#数据目录) · [大文件外链](#大文件外链配置)

## 应用机器人

机器人以量子密信开放平台的**应用机器人**接入：服务启动后用 AppID / AppSecret 取得访问令牌，主动连出到平台的事件 Stream（WebSocket）接收消息，再调用开放平台接口发送回复和文件。服务器不需要公网地址、入站端口、域名或隧道；只需能以 HTTPS（443 端口）访问 `imtwo.zdxlz.com` 和 `imfl.zdxlz.com`（Docker 部署时由容器访问）。

在开发者后台准备：

1. 新建企业自建应用（首次使用需单位超级管理员先登录后台并添加开发者成员），在应用中启用机器人能力。
2. 记下 AppID 和 AppSecret，部署向导会要求填写；环境默认“线上”，只有使用预发环境时才改。
3. 权限按最小化授予：
   - 必需：`basic:appBasic`、`basic:chat:single`、`basic:chat:group`、`getAccess:addressBookRange`、`file:tempStorage`，以及通讯录的部门、成员列表读取权限。
   - 建议移除：通讯录的增删改员工和部门（`addressbook:user`、`addressbook:dept`）、用户同步（`addressbook:sync`）和公众号推文。凭据保存在服务器上，Windows 原生部署时 `bash` 工具拥有运行账户的权限且能联网，出错的模型可能调用这些写接口；本项目只读通讯录。
4. 通讯录可见范围（`getAccess:addressBookRange`）要覆盖所有会使用机器人的成员。机器人按通讯录把平台 ID 对应到手机号，统计和会话都按手机号归属；不在范围内的成员会因“无法确认身份”被拒收。

事件订阅要等服务运行后才能验证，见[接入开发者后台](#接入开发者后台)。一个应用同一时间只能有一个服务实例连接 Stream：不要让两套部署、测试实例或调试工具共用同一个应用，否则事件会被分走。

凭据保存在 `data/config/app-bot.json`（仅所有者可读写），正常重启和同代升级沿用。更换 AppSecret 或换成另一个应用时，用 TUI「系统 → 设置 → 应用机器人」或 `ops configure-app-bot`：向导验证新凭据后才替换，期间机器人暂停；换应用或环境后通讯录映射随新应用重新同步。

## 选择部署方式

| 方式 | 主机要求 | 文档解析环境 |
| --- | --- | --- |
| Windows 原生 | Bun 1.4.4+、Git for Windows 的 GNU Bash（找到的若是 WSL 启动器 `System32\bash.exe` 或 `WindowsApps\bash.exe`，bash 工具会拒绝运行）、原生 `uv.exe`；管理员 PowerShell 部署 | Python 3.14 共享文档环境按需准备；Word/PPT 预览另需 LibreOffice |
| Linux / Docker | glibc Linux、Git、Docker Engine、Bash、curl、coreutils、util-linux 的 `flock`；rootful Docker 由 root 部署和升级，rootless Docker 由其所属用户部署 | 镜像预装 Python 3.14、锁定的文档库、LibreOffice 和中文字体 |

Linux 工具进程监督需要访问 `/proc`；不支持 macOS、Alpine/musl。Docker 的配置向导与应用运行在镜像内，宿主机无需额外安装 Bun；若使用[运维界面](tui.md#运维界面)，则需在宿主机安装 Bun 1.4.4+。

rootful Docker（以 root 运行的默认安装）下，部署、升级、继续和回滚都要由 root 执行，例如 `sudo bash scripts/deploy/deploy.sh`：只有 root 能完整查看镜像存储所在磁盘的剩余空间，并按服务的身份给新建的文件设置属主。docker 组中的普通用户会在任何提问、构建和停机之前被拒绝，脚本不会自动 sudo。rootless Docker 由它所属的普通用户运行，不要用 sudo。

容器进程的身份：真正的首次部署时，root 部署的容器降权到 UID/GID 1001，并把挂载目录的属主改成它；rootless Docker 下以容器内的 root 运行，它映射回宿主机上的部署用户，所以挂载目录仍归这个用户。之后的重新部署和升级沿用原容器 `mixin-chatbot`（运行或停止均可）的数值 UID/GID：停机前从原容器读取并核对，写入本次事务的快照，预览、迁移、验证实例、正式实例以及中断后的继续和回滚都用它；只给本次新建的目录和文件设置属主，不批量改已有数据的属主。原容器的身份不能可靠确定时（不是数值 UID:GID、数据目录不是本项目的、与 Docker 的模式不符），部署和升级在停机前停止，不猜测。原容器已被删除但部署过时，重新部署按 `data/state` 的属主提出身份，经确认后才使用；升级要求原容器存在。以前由 docker 组普通用户部署的实例改由 root 升级后，服务仍以原来的 UID/GID 运行。检出属于那个用户，git 拒绝以 root 操作它（仓库中的钩子和配置会以 root 运行）：确认信任这份检出后，由 root 执行一次 `git config --global --add safe.directory <项目目录>`，脚本不会代为加入；此后 root 升级时写入检出的文件属于 root。

机器人的 HTTP 服务只供本机管理（TUI、`/health`、关机与通讯录确认），原生部署和 rootful Docker（host 网络）都只监听 `127.0.0.1`。rootless 下 host 网络只是 rootlesskit 的网络命名空间，宿主机连不到，所以部署改为把端口发布到宿主机的 `127.0.0.1:<端口>`，容器内监听所有接口（由部署脚本设置，不来自用户配置）。发布端口的是以部署用户身份运行的 rootlesskit，低于 `net.ipv4.ip_unprivileged_port_start`（通常 1024）的端口默认发布不了：首次部署的默认端口因此改为 `11011`，`BOT_PORT` 指定或已保存的低端口会在停机前被拒绝，并提示改用高端口，或调低该内核参数、给 rootlesskit 加 `CAP_NET_BIND_SERVICE` 后重试；升级沿用的低端口同样在停机前停止。rootless 下机器人容器和外链管理的一次性容器都访问不到只监听宿主机 `127.0.0.1` 的服务（例如本机的 MinIO 或本地模型接口），监听非回环地址的服务可以用宿主机的该地址访问。启用 SELinux 强制模式的主机尚未验证。

基础组件通过官方渠道安装：[Bun](https://bun.sh/docs/installation)、[uv](https://docs.astral.sh/uv/getting-started/installation/)、[Docker Engine（Debian）](https://docs.docker.com/engine/install/debian/)。

### Python 与文档预览

Python 小版本范围固定为 `>=3.14,<3.15`，补丁版本由 uv 选择；依赖及传递依赖由 `uv.lock` 锁定。Windows 和 Docker 默认都使用应用共享的 `data/runtime/document-env/`，首次使用时按需 `uv sync`；不会自动使用项目根目录 `.venv`。依赖从下载缓存复制安装，避免硬链接导致原地修改相互影响。

管理员显式配置 `BOT_DOCUMENT_ENV` 时改用指定的现成环境（TUI「设置 → 高级运行参数 → 文档处理」中的「共享文档环境覆盖」，留空或恢复默认即用 `data/runtime/document-env`）。Docker 镜像里的 `/app/.venv` 用于构建验证和显式选择。共享环境缺失或与当前配置不一致时由 uv 按需准备，因此首次使用文档功能可能需要联网下载 Python 和依赖。生成文件保留在用户 tmp，环境只存工具依赖。

通常无需手工同步。需要预热时，停止服务，在项目根目录执行：

```powershell
$env:UV_PROJECT_ENVIRONMENT = (Join-Path $PWD 'data/runtime/document-env')
uv sync --locked --no-dev --no-install-project
if ($LASTEXITCODE -eq 0) {
    bun scripts/runtime/document-manifest.ts . $env:UV_PROJECT_ENVIRONMENT
}
Remove-Item Env:UV_PROJECT_ENVIRONMENT
```

Linux 的同等操作为 `UV_PROJECT_ENVIRONMENT="$PWD/data/runtime/document-env" uv sync --locked --no-dev --no-install-project`，成功后运行 `bun scripts/runtime/document-manifest.ts . "$PWD/data/runtime/document-env"`。marker 只记录预期配置，运行时仍验证实际解释器、依赖及导入。

Windows 若需 Word/PPT 预览，从 [LibreOffice 官网](https://www.libreoffice.org/download/download-libreoffice/)安装。在 TUI「设置 → 高级运行参数 → 文档处理」的「LibreOffice 程序路径」中填写程序的绝对路径，例如 `C:/Program Files/LibreOffice/program/soffice.exe`；便携版填写其 `program/soffice.exe` 的绝对路径。留空时先从服务账户的 PATH 查找 `soffice`、`libreoffice`，Windows 再查标准安装目录。Linux 同样可设置，如 `/usr/bin/soffice`；隔离任务须填写任务容器内已存在的程序路径，Docker 镜像预装 LibreOffice，通常保持自动查找即可。指定路径无效时会报错，请修正或恢复自动查找。变更后重启服务。PDF 预览直接使用 Python 库。预览字体取自运行主机，建议安装与客户模板一致的字体；Docker 提供 Noto CJK。缺少 LibreOffice 时仍可编辑和组装文件，工具会明确报告未完成视觉检查。

只读 Docker 容器需要可写的 `/tmp`，例如 `--tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777`；部署脚本已提供该挂载。LibreOffice 的 Unix 进程通信文件使用 `/tmp`，仅设置 `TMPDIR` 无法代替它。每次转换的 LibreOffice 用户配置（profile）放在系统临时目录下单独创建的目录（容器内即该 `/tmp`），任务结束、失败或取消后删除，文档工具同时最多两次转换；缓存和输出放在本次任务临时目录。Windows 上 profile 目录较深时曾出现 LibreOffice 退出码为 0 却不生成 PDF，因此不放在数据目录下，服务账户的 TEMP 也应保持较短路径。转换错误会保留 LibreOffice 的诊断输出。

## 执行部署

先获取代码，再进入项目目录：

```sh
git clone https://github.com/jaykwok/mixin-chatbot.git
cd mixin-chatbot
```

在项目根目录选择对应入口。脚本会引导填写应用机器人凭据（验证能取得访问令牌，但不连接 Stream）和模型配置、保存运行设置并检查新实例。

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

首次部署直接创建当前存储结构。后续重复部署时，脚本先暂停已有实例并保存配置、启动定义、依赖或镜像及原运行状态，停止时明确提示“已停止机器人服务”；Windows 与 Docker 都在停止前确定共享资料目录并问完是否重新配置 AI（本机端口不询问，见下节），取消不会改动部署，只有凭据和 AI 向导因依赖重装或新镜像而在停止后运行。部署失败会尝试回滚，恢复失败则保留现场并报错。旧版 webhook 发布的目录不能重新部署或升级，见[从旧版 webhook 发布切换](data-migrations.md#从旧版-webhook-发布切换)。部署被强制中断或回滚未完成时，重新运行部署脚本会先显示上次操作的记录，询问继续还是回滚；继续只使用停机前确认的设置，数据已提交时只能继续，详见[中断恢复](operations.md#中断恢复)。Windows 计划任务优先使用 S4U 开机启动，受系统限制时回退到登录启动，并显示实际方式。

### 本机管理端口

本机端口只供 TUI、`/health`、关机和通讯录管理使用，只在本机回环地址上可达；消息经 Stream 主动连出接收，不需要开放入站端口、域名或隧道。部署不询问端口：首次部署使用 `1011`，rootless Docker 不能发布低端口时使用 `11011`；之后的重新部署和升级沿用已保存的端口（`data/state/bot-port`），继续和回滚只用事务记录中的端口。

端口与其他程序冲突或需要指定时，设置环境变量 `BOT_PORT` 后重新部署；新端口会保存下来，之后沿用：

```sh
BOT_PORT=12011 bash scripts/deploy/deploy.sh    # rootful Docker：sudo BOT_PORT=12011 bash scripts/deploy/deploy.sh
```

```powershell
$env:BOT_PORT='12011'; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/deploy.ps1
```

端口无效、rootless Docker 发布不了，或者新端口已被其他程序占用时，部署在停止服务前报错并说明改法，不会自动换用别的端口。沿用的端口不做占用探测（原服务可能正在使用它）。升级不读取 `BOT_PORT`，改端口只能重新部署。

## 接入开发者后台

平台的“验证连接”要求服务已经连上 Stream，所以先部署并启动服务，再到开发者后台配置事件订阅：

1. 在应用的事件订阅中选择 **Stream**。
2. 确认服务正在运行（`doctor` 中“事件 Stream”为通过），点 **验证连接**，显示连接成功。
3. 勾选机器人接收消息事件，保存。
4. 在客户端把应用机器人加入要使用的群。从旧版（webhook 自定义机器人）切换时，同时从各群移除旧的自定义机器人。

部署后按以下顺序验证：

1. 运行 `doctor`，检查配置、服务、事件 Stream 和通讯录同步。首次部署后通讯录在后台完整同步一次（全量通讯录可能需要几十分钟），完成前未同步到的成员会收到“正在同步通讯录”的提示；进度见 `directory` 命令或 TUI「系统 → 通讯录」。
2. 在测试群 @ 机器人，发送“只回复 OK”，确认收到回答；再在单聊中发一条消息验证。
3. 将资料同步到共享资料目录（默认 `data/workspace/`），再请求查找资料、发送文件，并验证 `/status` 和 `/stop`。目录位置见[数据目录](#数据目录)。

本地 `/health` 只能确认应用就绪；收到群内回复和文件后，才完成实际交付验证。

平台只在连接断开时约 5 分钟后补推一次期间的消息：服务重启、升级的停机时间应控制在 5 分钟以内；停机更久时，期间发出的消息可能收不到，需要请成员重发。Stream 断开后服务自动重连，断开超过 1 分钟写告警日志，超过 2 分钟 `doctor` 判为失败、TUI 总览标红。

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

Pi Durable 的引擎策略独立保存在 `data/runtime/pi/settings.json`；原生预算、上下文缓存和可选辅助模型、MCP 的配置方式见[运行设置与可选工具](runtime-tools.md)。数据格式与升级规则见[版本、数据格式与从旧版切换](data-migrations.md)。

部署脚本保存支持的设置，未显式指定的值沿用已存配置。仅在前台启动时设置环境变量不会自动落盘；停机后可运行 `bun run configure-runtime` 保存当前支持项。配置文件中的未知键、无效类型及越界值会阻止启动。

日常调整可进入 **系统 → 设置 → 高级运行参数**，按“并发与附件、超时与退出、缓存与索引、文档处理”选择。Enter 修改，`d` 恢复选中项的默认值，`s` 预览并保存；默认值与机器人运行时共用定义。Esc 返回保留当前草稿，退出 TUI 前会提醒尚未保存的修改。本机端口、监听地址和共享资料目录属于部署设置，不在这里修改，见[本机管理端口](#本机管理端口)。

确认后才短暂停止运行中的机器人，保存并通过健康检查后恢复；原本停止的实例保持停止。应用或健康检查失败时尝试恢复原配置；并发修改不会被覆盖。界面显示的是保存值与默认值，环境变量仍有更高优先级：保存前检查 Windows 当前环境或 Linux 容器的相关覆盖，发生冲突时拒绝写入；自定义计划任务还需检查其启动环境。

| 设置 | 默认值 | 范围 / 说明 |
| --- | --- | --- |
| `BOT_PORT` | 1011（rootless Docker 不能发布低端口时为 11011） | 1–65535；部署时用环境变量指定，保存在 `data/state/bot-port`，见[本机管理端口](#本机管理端口) |
| `BOT_HOST` | 127.0.0.1 | 只接受回环地址 `127.0.0.1`、`::1` 或 `localhost`；HTTP 只供本机管理 |
| `WORKSPACE_ROOT` | data/workspace | 共享资料目录；可指向已存在的外置目录，服务只读，部署不创建、不改属主。部署时用环境变量指定（设为空恢复默认），见[数据目录](#数据目录) |
| `BOT_MAX_ACTIVE_REQUESTS` | 32 | 1–1000，普通请求总量 |
| `BOT_BASH_TIMEOUT` | 600 秒 | 10–3600 秒；工具可声明其他时限，最高 3600 秒 |
| `BOT_RUN_TIMEOUT_SECONDS` | 1200 秒 | 10–7200 秒，覆盖准备、模型、工具与最终交付 |
| `BOT_MODEL_IDLE_TIMEOUT_SECONDS` | 180 秒 | 10–7200 秒；模型等待或输出期间连续无有效进展的上限 |
| `BOT_MODEL_RESPONSE_TIMEOUT_SECONDS` | 600 秒 | 10–7200 秒；单次模型响应的上限，持续输出也不续期 |
| `PI_CACHE_RETENTION` | short | Pi 原生 short/long，服务商决定实际期限；不提供全局 none，`settings.json` 显式设置的 `durable.stream.cacheRetention` 优先。Durable 引擎不做缓存保温 |
| `BOT_ATTACHMENT_CONCURRENCY` | 2 | 1–8；在小附件读取前预约，覆盖读取与上传，限制内存峰值 |
| `BOT_SHUTDOWN_TIMEOUT_SECONDS` | 20 秒 | 5–25 秒，覆盖 HTTP、任务、进程与租约收尾 |
| `BOT_INDEX_TTL_MINUTES` | 5 分钟 | 1–1440 分钟，活跃会话每轮检查 |
| `BOT_INDEX_MAX_FILES` | 50000 | 100–1000000 |
| `BOT_INDEX_MAX_DEPTH` | 12 | 1–64 |
| `BOT_DOCUMENT_ENV` | data/runtime/document-env | 留空使用应用共享的按需环境；填写则改用指定的现成环境 |
| `BOT_DOCUMENT_WORK_ENABLED` | `1` | 文档加工模块开关；`0` 同时关闭 skill、六个文档编辑、生成与预览工具及模块提示词，重启生效；基础解析和发文件保留 |
| `BOT_DOCUMENT_PPTX_TEMPLATE` | 未设置（内置版式） | `.pptx`/`.potx`；生成 PPT 未指定模板时套用，见下文 |
| `BOT_DOCUMENT_DOCX_TEMPLATE` | 未设置（内置版式） | `.docx`/`.dotx`；生成 Word 未指定模板时套用，见下文 |
| `BOT_DOCUMENT_OFFICE_PATH` | 未设置（自动查找） | LibreOffice 程序的绝对路径；Windows/Linux 均支持，隔离任务填写任务容器内路径，重启生效 |

### 默认文档模板

`BOT_DOCUMENT_PPTX_TEMPLATE`、`BOT_DOCUMENT_DOCX_TEMPLATE` 在 TUI「设置 → 高级运行参数 → 文档处理」中分别为「默认 PPT 模板」「默认 Word 模板」，应用后重启生效。机器人用 `document_build` 生成文档且没有指定模板时套用它们；用户或机器人指定了其他文件时以指定的为准。

- 相对路径（如 `模板/公司.potx`）在共享资料目录中查找，不能含 `..`，也不能经链接指向资料目录之外。找不到这个文件时照常使用内置版式，并在工具结果中提示，不报错。
- 绝对路径按服务看到的路径填写。Windows 直接填文件路径；Linux Docker 填容器内路径，例如放在宿主机 `data/templates/公司.potx`，填写 `/app/data/templates/公司.potx`。
- 支持普通文档（`.pptx`/`.docx`）和 Office 模板（`.potx`/`.dotx`）。Office 模板在本次生成的临时副本中转换后使用，原文件不变。PPT 模板中有封面、封底等样例页时，可在对话中要求保留（`keepSlides`）；只含母版和版式的 `.potx` 仍能生成，标题样式按版式推断，首次使用建议看一下渲染效果。

### 数据目录

一个部署对应一个应用机器人：全部单聊和群聊读取同一份共享资料，会话库按空间（全部单聊共用一个库，每群一个库）隔离，临时文件按空间、成员和请求隔离。

```text
data/
├── config/
│   ├── models.json            Pi 原生服务商、凭据与模型定义
│   ├── runtime.json           持久运行设置
│   ├── app-bot.json           应用机器人 AppID、AppSecret 与环境（0600）
│   ├── relay.json             可选大文件分发配置
│   ├── auxiliary.json         可选分类、图片模型引用与并发预算
│   ├── mcp.json               可选 MCP 服务器、传输与工具白名单
│   ├── directory.json         可选通讯录同步范围（只同步列出的部门）
│   ├── task-deployment.json   Linux 任务隔离部署清单（私有，部署脚本维护）
│   └── materials-ignore.txt   资料索引排除规则（自动生成模板，手工维护）
├── workspace/                 默认共享资料目录（WORKSPACE_ROOT 可指向外置目录），模型只读
├── index/                     资料索引 materials.md、扫描 manifest 与 parsed/ 解析缓存，可重建
├── conversations/
│   ├── direct/durable.sqlite  单聊空间库（Pi Durable）：全部单聊成员的会话、排队消息、控制命令、待交付内容与附件登记
│   └── groups/<群>/durable.sqlite  群空间库（另有 -wal 等，需一起备份）
├── tmp/
│   ├── direct/<成员>/         单聊成员 tmp：received/ 收到的文件，tasks/msg-<请求>/ 生成物与中间产物
│   └── groups/<群>/<成员>/    群成员 tmp
├── state/
│   ├── stats.sqlite           使用统计账本：独立于会话历史，清空上下文不影响统计
│   ├── agent.sqlite           通讯录映射（平台 ID → 手机号、姓名，0600）与路径身份
│   ├── relay.sqlite           远端对象的持久账本
│   ├── data-version.json      部署记录：数据格式、程序版本、构建与发布事务号
│   ├── release-data.json      当前发布的验证/提交状态
│   ├── instance.json          实例 PID、启动时间与关闭令牌
│   ├── workspace-root         Linux 部署保存的外置资料目录（空为默认）
│   ├── reclamation/           tmp 离线回收的清单、快照与归档（backup/rm）
│   └── ...                    部署状态与维护租约
└── runtime/
    ├── pi/settings.json       Pi 选型与 Durable 原生运行策略（需备份）
    ├── mcp/                   可选 MCP OAuth 凭证（按秘密配置备份）
    ├── models-store.json      模型目录缓存，动态目录服务商离线启动时需要
    ├── document-env/          共享文档解析环境，按需准备，可重建
    └── ...                    其余 Pi 资源与启动脚本，可重建
backup/                        为了能撤销某个操作而留的；清理用 backup-scan / backup-clean，别手动删
├── snapshots/                 部署与升级的回滚现场
└── rm/                        部署期间被替换的旧文件；操作期间的归档在 rm/<快照名>/
tmp/                           报告、测试隔离 cwd、诊断产物、一次性脚本；无任务使用时可清理
├── reports/                   TUI 导出的离线 HTML 报表
└── backup-cleanup/            历史归档清理的清单和执行结果
logs/                          应用日志与操作日志
```

群和成员标识会编码为安全目录段；映射到已有目录的大小写别名会被拒绝，避免 Windows 串会话。单聊空间在 `conversations/direct`、`tmp/direct` 下，群在 `groups/` 下，二者不会冲突。资料同步到共享资料目录，所有单聊和群都能读到；生成物写入各成员 tmp 的任务目录。通讯录映射是一份内部通讯录副本，与平台凭据同等敏感，不进日志和诊断包。

外置共享资料：部署时设 `WORKSPACE_ROOT=<已存在的目录>`（Windows 写入 `runtime.json`，Linux 保存在 `data/state/workspace-root`，Docker 只读挂到容器 `/app/workspace`）；设为空恢复默认 `data/workspace`。部署不创建、不改属主，服务身份需能读取其中的资料；卸载不会删除外置目录。外置目录不能包含 `data/` 或位于受管目录（`data/` 下的 `config`、`state`、`conversations`、`tmp`、`index`、`runtime`，以及 `backup/`、`logs/`）内；受管目录也不能经链接或 junction 落在外置目录里，否则其中的配置和会话会被成员工具读到。部署在停机前、服务在启动时按解析链接后的位置检查，不符合即拒绝。

历史、统计和临时文件命令按会话空间选择：群用群号，配合 `--group-id`（原始群号）或 `--storage-segment`（已编码目录段），两者互斥；单聊空间用 `--direct`（`stat`、`tmp-*` 的 `--group` 写 `direct`）。PowerShell 包装器对应 `-GroupId` / `-StorageSegment` / `-Direct`。未指定时自动判断，遇到两个不同群同时匹配则拒绝操作。TUI 会传入明确的目录段。

建议正常停机后备份整个 `data/`，并单独备份外置的共享资料目录。`data/runtime/pi/settings.json` 是必须保留的模型选型；`data/runtime/models-store.json` 也应随配置备份，动态目录服务商依赖它离线启动，移除后需重新运行向导联网刷新。SQLite 使用 WAL，运行中只复制主 `.sqlite` 文件可能遗漏数据。

空间库和 tmp 里的结果文件必须作为同一批数据备份；只有数据库不能恢复图片、附件或全文。停机后可运行 `bun scripts/ops/data-backup.ts backup <新目录>`：取得维护租约、检查并 checkpoint 所有数据库，再复制 `state`、`conversations`、`tmp`、`index` 和默认的 `workspace`（外置资料目录不在内，tmp 归档和诊断快照跳过），写入逐文件 SHA-256 清单。配置、密钥、模型目录缓存和选型仍需另行备份。恢复命令 `bun scripts/ops/data-backup.ts restore <备份目录> <空暂存项目>` 先验证全部摘要，再复制到空目录并检查 SQLite；配置补齐后运行 `bun scripts/runtime/data-current.ts validate --project <暂存项目>`，验收通过再切换。恢复工具不会覆盖正在使用的数据。

Windows 启动器对非零退出等待 60 秒后启动新进程，最多重试 999 次，正常退出不重试；停止机器人也会停止启动器。此退避让旧服务租约有时间过期。修改代码后需按正常部署流程更新启动器；运行中的服务不会自动切换到这份代码。

### 大文件外链配置

外链是可选的：不超过 30 MiB 的文件始终以平台原生文件消息发送；超过 30 MiB 的本地文件可上传到兼容 S3 的私有存储桶，通过限时预签名 URL 分发，接收者直接从对象存储下载。未配置外链时，超过 30 MiB 的文件发送失败并明确报错。

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

相同后端、内容和文件名仅在剩余期限不少于当前配置的 90% 时复用（默认至少 108 分钟）；不足时，新分享上传到新的唯一对象路径并获得完整期限。旧对象仍保留原下载期限和删除余量；查看列表、重发或修改配置都不延长旧期限。群消息显示北京时间（UTC+8）的到期时刻。

上传成功后无法核验大小时不发链接。旧对象探测返回 404 或 403 时，新分享改用新路径上传，必须完成 PUT 和上传后的严格 HEAD 核验才发送链接，不覆盖旧路径；其他服务器或网络错误直接报错并保留记录。AWS 在没有 ListBucket 权限时也会用 403 表示对象不存在，不能把它一律解释成密钥错误，见 [HeadObject 权限说明](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)。上传、核验和删除请求的签名在请求超时之外增加 5 分钟余量，仍需保持系统时钟同步；下载签名期限不增加这份余量。

服务启动时扫描，随后每 5 分钟尝试清理到达 `deleteAfter` 的对象；扫描不会与自身重叠，也不等待会话或统计维护。删除成功或确认对象不存在才移除账本，失败下轮重试。因此计划时间不是物理删除的精确时刻；长下载、网络故障和停机都不能保证届时文件已删除。未完成上传超过上传预算加一分钟后可被回收（默认 31 分钟）。

云端应再设覆盖分发对象的生命周期作为停机/账本丢失兜底：根目录布局覆盖整个专用桶，配置了 `prefix` 时只覆盖该目录。默认设置可使用一天或更长的保留期；实际规则必须长于上传预算、下载期限和删除余量之和。生命周期通常按天或异步处理，不能代替两小时下载签名。专用临时桶应关闭版本控制、对象锁及复制；已有历史版本需单独处理，否则普通 DELETE 可能只创建删除标记，旧版本仍占空间。参见 [S3 预签名有效期](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)、[S3 版本化删除](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html)和 [R2 生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。

停用会归档配置并保留账本、远端文件，同时停止机器人的清理。切换端点、区域、桶或目录前应先在原配置下清空在册对象；向导保存前会提示不属于新设置的在册数量。新后端不会删除旧后端对象，后台每次运行对同一旧后端仅告警一次；可切回原配置清理，或在云端处理。doctor 的 S3 项只检查必填项，显示通过不代表云端权限、私有访问及签名已验收；修改配置或云端设置后，请在 **数据 → 外链 → 测试外链**（或 `bun run relay test`）上传测试文件确认，见[测试外链](operations.md#测试外链)。

## 数据版本与升级

当前程序版本 1.0.1、数据格式 1，Pi 精确锁为 1.4.0（会话库为 Durable SQLite schema 2）。部署与升级按部署记录 `data/state/data-version.json` 判断：没有记录也没有数据时全新安装；记录有效且数据格式一致时正常升级；有数据但没有有效记录，或记录损坏、缺字段、格式不受支持时拒绝，现场保留。部署记录还登记数据所属的应用（平台环境与 AppID），换应用或环境时拒绝。旧版 webhook 发布不能原地升级，需在新目录全新部署；只有旧版统计可一次性导入（见[导入旧版统计](data-migrations.md#导入旧版统计)），其余数据都不迁移。完整规则见[版本、数据格式与从旧版切换](data-migrations.md)。

## 任务隔离部署

Linux Docker 的新部署和升级需要与服务宿主 UID 匹配的本机 rootless Docker daemon，用于执行 bash、文档处理与解析。rootless 服务可复用自己的 daemon；rootful 服务沿用原数字 UID/GID，首次部署默认 UID 1001，因此需要属于 UID 1001 的 rootless socket。默认位置是 `/run/user/<UID>/docker.sock`，首次配置可通过 `BOT_TASK_DOCKER_HOST=unix:///绝对路径/docker.sock` 指定。脚本在停机前检查 socket 属主、daemon 身份、固定镜像与路径映射；缺少条件时停止，不安装 daemon、不改变服务身份或自动 sudo。

部署把同一不可变镜像同步到任务 daemon，并保存 `data/state/task-runtime` 和私有的 `data/config/task-deployment.json`。控制面获得 socket；任务容器只获得自己的可写目录及只读输入，使用 `--network none`。升级提交后按快照中的固定容器 ID 撤销旧业务容器，确认其不能被迟到的启动请求重新启动后才恢复业务。不能手工改映射或换 daemon 绕过检查：原回执绑定旧映射，须先在原环境中完成处置。

独立任务 daemon 上的旧镜像在部署提交、正式实例就绪并完成事务收尾后清理；原本停止的实例保持停止。清理只针对当前项目标识下、无标签及摘要引用的旧镜像，保留当前镜像和被运行中或已停止容器引用的镜像，不强制删除，也不清理其他项目或父镜像。取消预览、回滚和异常退出留下的副本，在下一次成功部署或升级时回收；事务未完成时不会清理。清理失败会告警，下次成功提交重试，不撤销已成功的部署。服务与任务共用同一个 daemon 时沿用服务镜像的标签生命周期。项目目录移动后标识变化，旧目录标识下的镜像不会被新目录自动认领或删除。

每次 bash 的 `PI_USER_TMP` 是新任务目录。要读之前的临时产物，在 `input_paths` 中显式列出；共享资料和资料索引仍只读可见。Windows 原生部署不隔离 bash，工具说明里也不出现隔离提示和 `input_paths` 参数。输入继续受单文件 128 MiB、总计 256 MiB 和 20000 条目限制，无关的历史 tmp 不再进入快照。隔离文档使用镜像内 `/app/.venv`；每个工作容器的 Office profile 位于自身 `/tmp`，工作容器退出并撤销后释放，不在服务容器的 64 MiB `/tmp` 中累积。

隔离模式下 `send_image`、`send_file` 只下载公网 HTTP(S) 地址：拒绝私网、回环、链路本地、特殊用途地址、带凭据的 URL 和所有重定向；DNS 全部结果通过后固定连接地址。需要下载跳转后的资源时应提供最终公网地址。管理端模型、MCP 与已配置的外链后端仍属于可信控制面。
