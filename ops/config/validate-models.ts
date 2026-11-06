#!/usr/bin/env bun
// 部署和 doctor 的离线前置检查：走服务端启动时同一条路径，确认 Pi 能离线解析出选中的
// 模型并且凭证齐全。
//
// 用法：validate-models.ts [项目根目录]。默认当前目录；配置路径由 src/core/storage.ts
// 固定在项目根之下，所以脚本先切到那里再交给 Pi。
import { openModelRuntime, openSettings, resolveModelSelection } from "../../src/core/model-config.ts";

try {
  const root = process.argv[2];
  if (root) process.chdir(root);
  const runtime = await openModelRuntime();
  const { model, thinkingLevel } = await resolveModelSelection(runtime, openSettings());
  console.log(`${model.provider}/${model.id} (api=${model.api}, thinkingLevel=${thinkingLevel})`);
} catch (error) {
  // 错误文本来自 Pi 的字段级描述或本项目的选型检查，不含配置内容和凭证。
  console.error(error instanceof Error ? error.message : "模型配置校验失败");
  process.exitCode = 1;
}
