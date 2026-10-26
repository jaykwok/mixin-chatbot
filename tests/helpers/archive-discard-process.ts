// Subprocess for archive-removal-safety.test.ts: under <fixture root>, archive one isolated task, start removing it,
// fail with EIO after the first data file is gone, then exit; prints the plan and outcome as the last JSON line.
import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { applyArchiveRemoval, applyTmpArchive, previewArchiveRemoval, previewTmpArchive } from "../../src/maintenance/archive.ts";
import type { MemberScope } from "../../src/maintenance/scope.ts";
import { RootlessTasks, type TaskDriver } from "../../src/core/rootless-tasks.ts";

const fixture = process.argv[2]!, root = join(fixture, "data"), temp = join(root, "tmp/groups/group-a/alice");
const scope: MemberScope = { async withMember(_paths, _member, _mode, run) {
  return run({ calls: {}, liveWork: false, protectedPath: () => false, settle: async () => {} });
} };
const image = "sha256:" + "a".repeat(64);
const driver: TaskDriver = { async run(args) {
  if (args[0] === "info") return { exitCode: 0, output: JSON.stringify({ ID: "archive-safety", SecurityOptions: ["name=rootless"] }) };
  if (args[0] === "image") return { exitCode: 0, output: JSON.stringify([{ Id: image, Os: "linux" }]) };
  throw new Error("Docker is never started here: " + args.join(" "));
} };

const backend = new RootlessTasks(join(fixture, "control"), image, driver);
const options = { root, state: join(fixture, "state.sqlite"), archive: join(root, "state/reclamation/backup/rm"), scope, backend };
const task = await backend.create(temp);
for (const name of ["data-1.txt", "data-2.txt", "data-3.txt"]) await fs.writeFile(join(task.path, name), name);
await task.seal();
const plan = await previewTmpArchive(options, 0);
await applyTmpArchive(options, plan.id, plan.digest);
const removal = await previewArchiveRemoval(options), at = removal.items.findIndex(item => item.task === task.id);
const original = fs.unlink;
let failed = false;
const spy = spyOn(fs, "unlink").mockImplementation(async path => {
  await original(path);
  if (!failed && /\/data-\d\.txt$/.test(String(path))) { failed = true; throw Object.assign(new Error("synthetic I/O failure"), { code: "EIO" }); }
});
let progress;
try { progress = await applyArchiveRemoval(options, removal.id, removal.digest); } finally { spy.mockRestore(); }
console.log(JSON.stringify({ id: task.id, removal: removal.id, digest: removal.digest, at, destination: removal.items[at]!.destination, status: progress.outcomes[at]?.status }));
