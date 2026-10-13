import { RootlessTasks, type TaskDriver } from "../../src/core/rootless-tasks.ts";
const [control, temp] = process.argv.slice(2);
const image = "sha256:" + "a".repeat(64);
const driver: TaskDriver = { async run(args) {
  if (args[0] === "info") return { exitCode: 0, output: JSON.stringify({ ID: "synthetic-daemon", SecurityOptions: ["name=rootless"] }) };
  if (args[0] === "image") return { exitCode: 0, output: JSON.stringify([{ Id: image, Os: "linux" }]) };
  throw new Error("No real Docker call allowed");
} };
const tasks = new RootlessTasks(control!, image, driver);
const task = await tasks.create(temp!);
console.log(JSON.stringify({ id: task.id, pid: process.pid }));
setInterval(() => {}, 1000);
