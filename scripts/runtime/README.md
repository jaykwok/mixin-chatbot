2.0 以前版本的 `ops update` 按固定路径导出升级器：scripts/deploy/upgrade.sh、scripts/lib、scripts/runtime 和 Dockerfile，
少一个路径就无法导出。这个目录只为让那次导出成功，好让 scripts/deploy/upgrade.sh 说明 2.0.0 需要全新部署。
