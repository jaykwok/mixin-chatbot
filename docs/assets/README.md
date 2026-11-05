# 截图维护

[返回项目首页](../../README.md) · [网页控制台](../console.md) · [开发指南](../development.md)

截图使用演示数据，不包含真实成员、群资料或凭据。日期、构建号和用量都是示例值，无需随每次代码提交更新。

| 图片 | 展示内容 | 更新时机 |
| --- | --- | --- |
| [console-overview.png](console-overview.png) | 总览：运行状态、事件 Stream、通讯录同步、部署与版本 | 总览布局或状态项变化 |
| [console-stats.png](console-stats.png) | 统计：筛选、指标卡片、对比、趋势、排行 | 统计页布局、指标名称或统计口径变化 |
| [console-conversations.png](console-conversations.png) | 会话：成员列表、对话、工具调用与用量 | 会话页布局或消息展示方式变化 |
| [console-maintain.png](console-maintain.png) | 维护：恢复、升级、重新部署、启停、备份清理、后台任务 | 维护页的操作或任务展示变化 |

## 重新生成

在项目目录运行（需要本机安装 Chrome 或 Edge）：

```sh
bun tests/helpers/console-screenshots.ts
```

脚本在 `tmp/` 下新建临时数据目录，写入演示统计和几段演示对话（模型回复是预设内容，不调用真实模型），启动机器人的只读接口和真实的控制台页面，用无界面浏览器截取四个页面，写入本目录后删除临时目录。不会读取或修改项目的 `data/`。维护页的后台任务列表是固定的演示记录。

可选参数：`--out <目录>` 改变输出位置，`--browser <路径>` 指定浏览器。不要手工修改截图中的界面文字或数值。
