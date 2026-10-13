// The configured isolated-task backend: one `RootlessTasks` per process, assembled from the deployment launch manifest
// (`MIXIN_TASK_DEPLOYMENT`) or the runtime settings. Callers share this instance; nothing is opened at import time.
//
// What a tool entry (bash, document_extract, document_environment, the document-work jobs) owns when it runs a task:
// - inputs: the worker sees its own `work` (writable), the explicit read-only host paths and the `inputs.paths` it
//   passes (copied into a private snapshot). Entries copy user sources into the task themselves, after
//   `assertTaskPathAllowed` and their own workspace/tmp checks;
// - reports: a result is a file the worker writes inside the task (a JSON report, the extracted text). stdout/stderr
//   are diagnostics and are never parsed into the result;
// - outputs: what a kept task leaves stays under the caller's tmp; the receipt sweep removes it once it is past
//   retention and unreferenced. Codemode result tasks are owned by result ownership instead (src/durable/results);
// - seal: the creator ends every task it created with `finishTask`, in a `finally`.
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "../contracts/paths.ts";
import { type IsolatedTask, RootlessTasks } from "./rootless-tasks.ts";
import { runtimeSetting } from "./runtime-config.ts";
import { readTaskLaunch } from "./task-deployment.ts";

let configured: RootlessTasks | undefined;
export const ISOLATED_PYTHON = "/app/.venv/bin/python";
export function configuredRootlessTasks(): RootlessTasks | undefined {
  if (configured) return configured;
  const launch = process.env.MIXIN_TASK_DEPLOYMENT ? readTaskLaunch(process.env.MIXIN_TASK_DEPLOYMENT) : undefined;
  const explicitImage = runtimeSetting("BOT_TASK_IMAGE");
  if (launch && explicitImage && explicitImage !== launch.image) throw new Error("任务镜像配置与部署清单冲突，请移除旧 BOT_TASK_IMAGE 后重新部署");
  const image = launch?.image ?? explicitImage;
  if (!image) return;
  if (process.platform !== "linux") throw new Error("BOT_TASK_IMAGE 只适用于 Linux rootless 任务部署");
  const explicitRoot = runtimeSetting("BOT_TASK_CONTROL_ROOT");
  if (launch && explicitRoot && resolve(explicitRoot) !== launch.controlRoot) throw new Error("任务管理根配置与部署清单冲突");
  return configured = new RootlessTasks(launch?.controlRoot ?? explicitRoot ?? fileURLToPath(new URL("../../data/runtime/task-control", import.meta.url)), image, undefined, undefined, launch);
}

/** How a tool call ends the task it created:
 * - "keep": writers retired; the work stays for the receipt sweep (bash: its output is under the caller's tmp);
 * - "keep-outputs": also discard the internal scratch `.work`; the outputs are the deliverable (a document job, a parse cache);
 * - "discard": nothing is delivered (a failure, a probe): reclaim it now. */
export async function finishTask(backend: RootlessTasks, task: IsolatedTask, outcome: "keep" | "keep-outputs" | "discard"): Promise<void> {
  await task.seal(outcome === "keep-outputs" ? { discardScratch: true } : undefined);
  if (outcome === "discard") await backend.reclaim(task.id);
}

/** Every host-side tool reader checks this after canonicalizing and before copying, hashing or using a cache. */
export async function assertTaskPathAllowed(path: string): Promise<void> {
  const backend = configuredRootlessTasks(); if (!backend) return;
  const canonical = await realpath(backend.root).catch(error => { if (error.code === "ENOENT") return backend.root; throw error; });
  if (isPathInside(path, backend.root) || isPathInside(path, canonical)) throw new Error("任务管理目录与回执不向工具开放");
}
