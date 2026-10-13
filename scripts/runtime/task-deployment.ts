import { parseArgs } from "node:util";
import { RootlessTasks } from "../../src/core/rootless-tasks.ts";
import { TaskPaths, type TaskLaunch } from "../../src/core/task-deployment.ts";
import { publishJson } from "../migrations/lib/io.ts";

const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true,
  options: { image: { type: "string" }, data: { type: "string" }, groups: { type: "string" } } });
if (positionals.length !== 1 || !["check", "write"].includes(positionals[0]!) || !values.image || !values.data) {
  throw new Error("用法：task-deployment.ts check|write --image <sha256> --data <宿主 data> [--groups <宿主外部群根>]");
}
const launch: TaskLaunch = { version: 1, image: values.image, controlRoot: "/app/data/runtime/task-control",
  mounts: [{ manager: "/app/data", daemon: values.data }, ...(values.groups ? [{ manager: "/app/group-data", daemon: values.groups }] : [])],
  imagePaths: ["/app/scripts/runtime", "/app/src/agent/modules/document-work", "/app/node_modules", "/usr/local/bin/bun"] };
new TaskPaths(launch, launch.image);
// This check never takes the running service's controller lock or modifies its manager receipts.
await new RootlessTasks(launch.controlRoot, launch.image, undefined, undefined, launch).verifyDeployment();
if (positionals[0] === "write") await publishJson("/app/data/config/task-deployment.json", launch);
console.log("任务隔离预检通过：rootless daemon、固定镜像与宿主目录映射一致");
