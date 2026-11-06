#!/usr/bin/env bun
// 部署的 configure-app / configure-models 步骤：在目标版本里安装停机前确认的配置暂存（configuration-stage.ts）。
// 先用网页配置发布同一套离线校验（configuration-check.ts，私有临时文件，不联网），再写入正式位置；
// 当前文件已是暂存结果时不重复写入（中断后续做），既不是停机前读到的也不是暂存结果时拒绝。
// 运维宿主持有部署锁并负责停机、回滚和启动，这里只核对和写文件；工作目录是项目根。
//
// 用法：configuration-install.ts --kind app|models --stage <文件> --json
import { resolve } from "node:path";
import { readBoundedText } from "../lib/bounded-text.ts";
import { Protocol, UsageError, parseOptions } from "../lib/maintenance-protocol.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { checkConfiguration } from "./configuration-check.ts";
import { installConfigurationStage, parseConfigurationStage, STAGED_KINDS, type StagedKind } from "./configuration-stage.ts";

function readStage(path: string): string {
  let text: string | null = null;
  try { text = readBoundedText(path, 64 * 1024 * 1024); } catch { /* Reported below. */ }
  if (text === null) throw new Error("暂存的配置无法读取");
  return text;
}

const protocol = new Protocol("json", "install");
try {
  const parsed = parseOptions("install", process.argv.slice(2), { flags: ["--json"], values: ["--kind", "--stage"], required: ["--kind", "--stage"] });
  if (!parsed.flags.has("--json")) throw new UsageError("install 只输出 JSON 结果：请加 --json");
  const kind = parsed.values.get("--kind")![0]! as StagedKind;
  if (!STAGED_KINDS.includes(kind)) throw new UsageError("配置类型只能是 app 或 models");
  const stage = parseConfigurationStage(readStage(resolve(parsed.values.get("--stage")![0]!)), kind);
  const { summary } = await checkConfiguration(stage.next, { root: process.cwd(), network: false, refresh: false });
  const installed = await withMaintenance(() => {
    // The deployment refused this before the stop; checked again under the lease.
    const transaction = readConfigurationState(process.cwd());
    if (transaction) throw new Error(`配置事务 ${transaction.id} 尚未结束（${transaction.phase}）`);
    return installConfigurationStage(process.cwd(), stage);
  });
  protocol.emit("success", { result: { installed }, text: [installed ? "已写入停机前确认的配置" : "停机前确认的配置已在位", ...summary].join("\n") });
} catch (error) {
  // A JSON syntax error can quote the bytes it stopped at; every other message here names fields or steps only.
  const reason = error instanceof SyntaxError ? new Error("配置不是有效 JSON") : error;
  protocol.fail(reason, error instanceof UsageError ? "refused" : "failed", error instanceof UsageError ? "" : "停机前确认的配置没有安装：");
}
