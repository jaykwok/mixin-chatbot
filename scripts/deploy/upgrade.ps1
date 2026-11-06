# 2.0 以前版本的 `ops.ps1 update`（含网页控制台的升级）导出目标提交并运行这个路径。
# 2.0.0 起数据格式为 2，不能原地升级：这里只说明原因并退出，服务、代码和数据都不改动。
Write-Host '[-] mixin-bot 2.0.0 起需要全新部署，不能从 2.0 以前的版本升级；本次没有停止服务，也没有改动代码和数据。' -ForegroundColor Red
Write-Host '    请在新目录全新部署，步骤见仓库 docs\data-migrations.md 的“从更早的版本切换”。'
exit 1
