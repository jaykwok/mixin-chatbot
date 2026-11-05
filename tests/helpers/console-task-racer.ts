import { readFileSync } from "node:fs";
import { TaskStore } from "../../scripts/ops/console/tasks.ts";
import type { TaskRequest } from "../../scripts/ops/console/tasks.ts";

const [root, inputPath, mode] = process.argv.slice(2) as [string, string, string];
const input = JSON.parse(readFileSync(inputPath, "utf8")) as { ids: string[]; at: number; input: Omit<TaskRequest, "version" | "id" | "createdAt" | "acceptBy"> };
const store = new TaskStore(root, () => input.at + (mode === "abandon" ? 100 : 99));
const wins = input.ids.map(id => mode === "abandon" ? store.abandon(id) : store.accept(id, { pid: process.pid, startedAt: String(process.pid) }));
const submitted = Array.from({ length: 12 }, (_, i) => store.create(input.input, `same-${i}`));
console.log(JSON.stringify({ wins, submitted }));
