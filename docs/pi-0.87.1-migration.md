# Pi 0.87.1 迁移说明

常规升级统一使用 TUI / ops 的「升级」，流程和平台过渡方式见[数据版本与升级事务](data-migrations.md)。迁移代码随仓库和 Docker 镜像发布，不需要从开发机器复制 tmp 工具。原研判见[任务清单](pi-0.87.1-upgrade-plan.md)。

## 配置变化

| 旧 runtime.json 值 | 转换结果 |
| --- | --- |
| 未设置 / auto | 删除 BOT_MODEL_CACHE_RETENTION，使用原生默认 short；保留已有 PI_CACHE_RETENTION |
| short / long | 改为同值的 PI_CACHE_RETENTION |
| none | 原生没有等价的全局禁用选项，预览要求明确接受原生缓存 |
| 与原生配置冲突 | 预览要求先决定使用的缓存语义 |

服务管理器、shell 和容器环境中的旧 BOT_MODEL_CACHE_RETENTION 需要管理员移除。cacheWarming 未配置时写为 off；已有合法值保留。off 仅关闭额外保温请求，不等于禁用服务端缓存。需要改变保温模式时修改 Pi 设置并重启。

旧 Codex 选型如需替换，升级预览会要求指定 provider/model，不会自动改选模型。最终以当前版本校验器核对配置和数据库；同版本且两侧标记配对时跳过数据转换与数据库快照。

## 历史工具与回退

早期本地 tmp 工具不属于仓库的发布接口，其说明不能作为新部署的操作步骤。历史统计修复必须针对原件和账本制定方案，保留缺失原件的世代；不能删除整库后仅扫描现存会话。

JSONL 仍为 v3，但新版会追加 system、usage、context_edit 和 compaction checkpoint，旧版本不能原地接写。提交前失败由升级事务恢复；提交后如需降级，应恢复升级前配套的代码、锁文件、配置和完整数据快照。停止所有数据库访问者后，成套恢复数据库与 WAL/SHM，不能拼接不同时间的文件。

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
