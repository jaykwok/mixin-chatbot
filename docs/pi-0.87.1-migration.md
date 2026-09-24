# Pi 0.87.1 迁移说明

代码只支持 0.87.1，两个直接依赖与配套 Pi 包均已锁定。原研判与分阶段状态见[任务清单](pi-0.87.1-upgrade-plan.md)。队列、文档隔离、取消和持久交付继续由本项目管理；会话上下文、压缩、重试、工具 strict 与保温使用官方 SDK。

## 常规升级

本版已把配置迁移纳入 TUI / ops 的升级事务，使用[数据版本与升级事务](data-migrations.md)。Docker 首次可直接升级；Windows 首次按“停机 → 旧版升级并保持停止 → 重新打开新版 TUI 再升级完成迁移 → 启动”过渡。下面的一次性工具用于旧流程和历史账目修复，不会登记数据版本。

## 旧版一次性停机迁移

工具在本地 `tmp/pi087/`，被 Git 忽略；部署前单独复制 `migrate.ts`、`repair-usage.ts` 和 `README.md`。Windows 原生部署在项目根目录运行，用实际服务账户和相同群数据根；Docker 部署按[下文](#docker-部署)在一次性容器内运行。不要把 `probe/` 覆盖到部署目录。

1. 先预览 `bun run tmp/pi087/migrate.ts`。损坏历史、链接目录、旧 Codex GPT-5.4/mini 选型会阻断。工具不执行凭据命令或调用模型。
2. 手动停止服务，备份配套代码、bun.lock、data/config、data/runtime、群数据及 SQLite 一致快照。工具备份只涵盖本次修改，不能替代部署快照。
3. 处理 shell、服务管理器和容器中的旧 `BOT_MODEL_CACHE_RETENTION` 环境变量：short/long 改名为同值的 PI_CACHE_RETENTION，auto 删除；none 无等价项，必须明确接受原生缓存语义后才移除。旧配置文件交给工具转换。
4. 执行 `bun run tmp/pi087/migrate.ts --apply`，再用新锁文件 `bun install --frozen-lockfile`。迁移后的配置不兼容旧应用。
5. 如已使用新版 usage 且旧投影曾入账，预览 `bun run tmp/pi087/repair-usage.ts`；确认报告后执行同命令加 `--apply`。旧 0.85.1 部署通常无需这一步。
6. 手动启动并验证 doctor、普通回复、文档与附件、外链、/stop、/clear、/deliver、重启续聊。真实模型收益和 Linux/Docker 发布验收仍需在部署环境完成。

两工具支持 `--project PATH`、`--groups PATH`；未传群根时按进程环境、runtime.json、data/groups 解析，解析出的群根不存在时阻断，不会当作没有会话。服务配置中的环境不会自动传给交互终端。应用时只使用部署项目已安装的 proper-lockfile 获取服务租约，缺依赖直接退出；租约被占用时应用会失败，不要绕过租约。配置迁移退出码：0 成功，2 预检阻断，1 执行错误。

### Docker 部署

宿主机上的 runtime.json 记录的是容器内群根（`/app/data/groups` 或 `/app/group-data`），宿主机通常也没有项目依赖，因此在一次性容器内运行工具，挂载与服务容器相同的目录。`<UID>:<GID>` 与服务容器一致：以 root 执行 deploy.sh 时为 `1001:1001`，否则为执行 deploy.sh 的账户。

```sh
docker run --rm --user "<UID>:<GID>" \
  -v "$(pwd)/data:/app/data" -v "$(pwd)/backup:/app/backup" \
  -v "$(pwd)/tmp/pi087:/app/tmp/pi087:ro" \
  mixin-chatbot bun run tmp/pi087/migrate.ts
```

自定义群数据根时另加 `-v "<宿主机群根>:/app/group-data"`，宿主机路径见 `data/state/group-data-root`。第 1、4 步使用这条命令，第 4 步末尾加 `--apply`；第 4 步的依赖安装改为执行 deploy.sh 重建镜像并启动。第 5 步需要新镜像：先停止服务，用相同挂载运行 `bun run tmp/pi087/repair-usage.ts`，完成后再启动。

### 缓存配置的变化

| 旧 runtime.json 值 | 转换结果 |
| --- | --- |
| 未设置 / auto | 删除旧字段，使用原生默认 short；保留已有 PI_CACHE_RETENTION |
| short / long | 改为同值的 PI_CACHE_RETENTION |
| none | 阻断：原生环境变量没有等价的全局禁用选项 |
| 与原生环境 / 配置冲突 | 阻断，要求先解决冲突 |

只有愿意放弃旧 none 或旧值优先语义时，才加 `--accept-native-cache`。此时保留原生设置，未设置则使用 short。`cacheWarming: "off"` 只关闭额外保温请求，**不等于禁用服务端缓存**。

未显式配置的 cacheWarming 会写为 off；已有合法值保留，可用 `--warming off|streaming|idle` 指定。short/long 均可配合三种保温模式。应用本身也默认 off，新装不会因 Pi 默认 streaming 而额外消费。

配置迁移先把每个修改文件的原始字节备份到 `backup/pi-0.87.1/<时间与ID>/`，附带路径和 SHA-256 清单，再逐文件原子替换；后续发布失败会尝试恢复已修改文件。进程被强制终止时按 manifest 检查并恢复或重跑。重复成功执行不增加备份，不改模型、凭据、JSONL、账本或服务。

### 历史账目修复

`repair-usage.ts` 仅支持现有 schema 1。它只用新版投影重算已入账前缀：原件前缀的 SHA-256 与 session ID 必须和账本一致，之后追加的内容不参与，由服务按新版投影正常入账。逐日逐 kind 校验数量、token 和总费用不变，只替换有变化世代的 usage 行。游标、提问数、工具数以及缺失原件的世代不变；完整账本备份包含已提交的 WAL 页面，可独立打开。

归档文件可用 `--archives MAP.json`，格式为 `{ "session-id": "归档文件绝对路径或相对部署根路径" }`。`unavailable`、`unverified` 或 `totalsMismatch` 非零时，对应账目保留原样，报告不表示历史已全部修复；`unverified` 表示原件被截短或已入账部分被改写。必须使用原部署时区。重算时把前缀复制到系统临时目录（仅当前账户可读），结束即删除。备份位于 `backup/pi-0.87.1/usage-<ID>/`。不要删除整库后仅扫描当前会话。

### 回退

会话 JSONL 仍为 v3，无需批量改写；新版会追加 system、usage、context_edit 和 compaction checkpoint。禁止让旧版原地接写新版历史。配置回退按备份 manifest 恢复原件；完整降级须恢复升级前配套的代码、锁文件、配置和整套数据快照。恢复数据库前停止所有访问它的进程，保留当时的数据库及 WAL/SHM 现场，避免将新 WAL 搭配旧备份。

## 可采用的原生设置

编辑 `data/runtime/pi/settings.json`，保留已有 defaultProvider/defaultModel。以下模型名是占位符，预算须按实际模型调整：

```json
{
  "cacheWarming": "streaming",
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "your-provider/your-model": { "reserveTokens": 8192, "keepRecentTokens": 12000 }
    }
  }
}
```

只在已验证的 `models.json` 模型定义或其 modelOverrides（不是上面的 compaction.modelOverrides）中填写以下元数据，不给未知代理复制原厂能力：

```json
{
  "inputLimits": {
    "images": {
      "resize": { "maxWidth": 1280, "maxHeight": 1280, "maxBytes": 2000000, "jpegQuality": 80 }
    }
  },
  "promptCache": { "short": 300, "long": 1800 }
}
```

maxBytes 是 base64 编码后的大小，缓存寿命单位为秒。read 处理新图片时使用当前模型限制；历史图片不因后续换模型重新编码。保温成本依赖模型价格和寿命元数据，Coding Plan 估算不代表实际套餐收益。先用 streaming 观测，idle 不是默认。启动日志显示保温模式；独立请求以 cache_warm 入账。

本次没有加入自动清理旧工具结果或强制文档收尾循环。它们是原计划有具体产品需求后才启用的 P2 项，避免自动省略用户仍需要的上下文或增加无界续跑。
