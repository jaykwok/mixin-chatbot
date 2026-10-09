# 运行设置与可选工具

Pi 1.1.0 接入只运行 Durable。修改以下配置前停止服务，使用升级事务完成数据版本校验，再启动服务。未配置辅助模型和 MCP 时，这些工具不注册。

## 原生运行设置

`data/runtime/pi/settings.json` 使用 `format: 1`；模型选择字段 `defaultProvider / defaultModel / defaultThinkingLevel / modelThinkingLevels` 仍由 Pi 管理。以下是默认运行策略，可省略使用默认值：

```json
{
  "format": 1,
  "durable": {
    "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 1000, "maxAgentDelayMs": 5000 },
    "stream": { "timeoutMs": 120000, "maxRetries": 0, "maxRetryDelayMs": 5000 },
    "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
    "progress": { "partialIntervalMs": 100, "outputIntervalMs": 20 },
    "contextRetentionMs": 600000
  }
}
```

`retry.maxRetries` 是第一次之外的重试次数，最多 10；`stream.maxRetries` 必须为 0，每个实际模型请求通过请求门记录独立开始回执。`timeoutMs` 是每次请求的期限，范围 1–600,000 毫秒；它不是用户消息的总处理期限。取消与未处理的控制命令继续阻止后续请求。

`compaction.modelOverrides` 的键为 `provider/modelId`，值只能含 `reserveTokens / keepRecentTokens`。`backgroundTokens` 可选，语义由 Durable 管理。`stream.cacheRetention` 可设 `none / short / long`；未设时沿用 Pi 的 provider 默认和 `PI_CACHE_RETENTION`，环境变量具体优先级由相应 provider 实现。旧缓存保温设置不再属于生产配置。

`contextRetentionMs` 范围 0–600,000 毫秒，是官方任务上下文缓存的闲置保留时间；0 在任务闲置后释放。它减少历史条目读取，但增加内存占用，且不限制活跃成员数量。多成员大历史部署可设 0。运维端直接调用 `Conversation.context()` 的查询仍需读历史，不能用它的耗时代表任务缓存效果。

## 文档分流与图片生成

可选 `data/config/auxiliary.json`：

```json
{
  "format": 1,
  "classifier": { "provider": "your-provider", "modelId": "your-classifier" },
  "image": { "provider": "your-provider", "modelId": "your-image-model" },
  "maxConcurrent": 2,
  "classifierRetries": 1
}
```

引用必须来自已经配置的官方模型目录，型别分别为 `classifier`、`image`；可只启用其中一种。带图分类还要求模型声明支持图片输入。凭证使用该 provider 的官方解析方式，例如 OpenAI classifier 要求 API key；ChatGPT 登录不自动提供这种权限。

`document_route` 返回 `text / ocr / layout` 与置信度，帮助选择文档处理路线；它不执行 OCR，也不替代现有文档工具。`generate_image` 调用官方图片模型，把生成图片保存在调用成员自己的 `tmp/codemode/`，返回受控路径和图片块。发送图片仍由现有 `send_image` 工具完成。两个辅助工具可直接调用，也可经 codemode 调用；原始 `models` 全局保持关闭。

这些操作产生模型费用，均为 unsafe，恢复时不自动重放。分类仅对官方判定的瞬时错误重试，范围 0–3 次；图片生成不自动重试。全服务共享并发上限 1–4，等待队列最多 32，每次模型请求期限两分钟。每次请求独立落开始回执，已确认 usage 单独入账一次；失败、取消或强杀后没有确认的用量保留为未知，不记成零，也不再并入父工具重复收费。文本输入最多 32,768 字符，参考图片最多四张。

## MCP 外部工具

可选 `data/config/mcp.json`，只接受管理员配置的服务器与明确工具白名单，最多八台、每台最多 64 个工具。例如：

```json
{
  "format": 1,
  "servers": [{
    "name": "documents",
    "transport": "http",
    "url": "https://your-server.example/mcp",
    "tools": ["search_documents"],
    "headersEnv": { "Authorization": "DOCUMENTS_AUTH_HEADER" }
  }]
}
```

`headersEnv` 的值是运行服务时已有的环境变量名，变量值是完整的请求头值，不写入模型可见目录。HTTP 要求 HTTPS，本机回环地址允许 HTTP；URL 不接受嵌入凭证。调用传递 URL 编码的 `X-Mixin-Group / X-Mixin-Member`，每次使用独立成员会话。外部服务需要自行验证身份和实施数据权限；这两个头不能替代外部服务的鉴权。

stdio 示例：

```json
{
  "format": 1,
  "servers": [{
    "name": "localdocs",
    "transport": "stdio",
    "command": "C:\\Tools\\mcp-server.exe",
    "args": [],
    "env": { "APP_MODE": "readonly" },
    "tools": ["search_documents"]
  }]
}
```

`command` 必须为该主机的绝对路径，参数不经 shell 展开。子进程只继承必要的 PATH/系统/临时目录变量和显式配置的 `env`，另带 `MIXIN_GROUP_ID / MIXIN_MEMBER_PHONE`；工作目录是成员 tmp。进程监督负责取消、stdin 关闭和父进程死亡后的后代回收。MCP roots 表达 workspace 只读与成员 tmp 的使用约定，**不构成 OS 文件系统隔离**；stdio 程序仍具有服务用户权限，只配置可信程序。

HTTP OAuth 可额外配置 `oauth: { "port": 43127, "clientId": "registered-client" }`，也可省略 clientId 采用官方动态注册流程；保密客户端用 `clientSecretEnv` 指定已有环境变量。停机后执行 `bun run mcp login documents`，按输出链接在浏览器授权；回调仅监听 `127.0.0.1`，登录期限两分钟，可取消。凭证按服务器名称和精确 URL 保存在 `data/runtime/mcp/`；备份应按秘密配置保护。服务启动不自动打开登录流程。

发现只读取工具目录；每次调用重查参数与结果 schema，目录变化会拒绝执行并要求管理员复核重启。工具经 codemode 按需发现，保持 unsafe、不自动重试、成员身份和取消边界，不能调用 model-only 的 `send_*`。长结果和图片按成员归属落盘，纳入现有 `/clear` 和保留清理。单条传输最多 8 MiB，活跃会话最多八个。

## 只读历史诊断

```sh
bun run history context <群号> <成员号码> [条目编号] [--group-id|--storage-segment]
bun run history timings <群号> <成员号码> [--group-id|--storage-segment]
```

诊断使用数据库的一致只读快照，在内存中打开暂停的 Harness，不创建分叉或模型请求。允许源库正在写 WAL，不写入源会话、配置或费用；SQLite 自身的读锁与共享内存由 SQLite 管理。当前限制为主库及序列化快照各 256 MiB，超出时拒绝诊断。

响应和普通工具使用官方 `durationMs`，任务用 `startedAt / endedAt`；任务跨度包含等待、重试和恢复，不能当作单次模型耗时。1.0.4 及更早记录缺字段时返回未知值和缺失数量，不补零。原始历史顺序保持不变；官方请求上下文仅在 system 之前都是 user 消息时把它前移，压缩后的历史仍需按实际上下文判断。
