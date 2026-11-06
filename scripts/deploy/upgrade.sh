#!/usr/bin/env bash
# 2.0 以前版本的 `ops update`（含网页控制台的升级）从目标提交导出这个路径（连同 scripts/lib、scripts/runtime）并运行它。
# 2.0.0 起数据格式为 2，不能原地升级：这里只说明原因并退出，服务、代码和数据都不改动。
printf '\033[0;31m[-] mixin-bot 2.0.0 起需要全新部署，不能从 2.0 以前的版本升级；本次没有停止服务，也没有改动代码和数据。\033[0m\n' >&2
printf '    请在新目录全新部署，步骤见仓库 docs/data-migrations.md 的“从更早的版本切换”。\n' >&2
exit 1
