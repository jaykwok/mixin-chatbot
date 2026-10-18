// Subprocess for legacy-reclamation.test.ts (UID 0, synthetic fixtures): one privileged step in its own process. The
// journal root's task-owner lock lasts for the process lifetime, so every step on one root runs in a fresh child.
// With `crash`, it exits with 70 at a journal save, like a crash: no catch block, restoration or close runs. `crash` is
// "<phase>[:<directories>]" (exit right after saving that phase, optionally with that many saved directories) or
// "before:<phase>" (exit before saving it). Without `crash` or `window` (below), it prints one JSON line
// { ok, pending?, message?, result? }.
// Usage: legacy-crash-process.ts '<request JSON>'
//   { "kind": "reclaim", "path", "proof", "journal", "operation", "crash"? }
//   { "kind": "discard", "groups", "journal", "id", "digest", "crash"? }
//   { "kind": "preview", "groups", "journal" }
//   { "kind": "reclaim-preview", "groups", "journal" } and { "kind": "reclaim-apply", "groups", "journal", "id", "digest", "crash"? }
//     (physical reclamation of shared results; the plans directory is the journal root)
import { spyOn } from "bun:test";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import * as io from "../../scripts/lib/atomic-file.ts";
import { applyArchiveRemoval, previewArchiveRemoval } from "../../src/maintenance/archive.ts";
import { LegacyReclamationPending, reclaimLegacy } from "../../src/maintenance/legacy.ts";
import type { MemberScope } from "../../src/maintenance/scope.ts";

const request = JSON.parse(process.argv[2]!);
if (request.crash) {
  const [when, phase, count] = request.crash.startsWith("before:") ? ["before", ...request.crash.slice(7).split(":")] : ["after", ...request.crash.split(":")];
  const original = io.publishJson;
  spyOn(io, "publishJson").mockImplementation(async (path: string, value: unknown) => {
    const journal = value as { phase?: string; directories?: unknown[] };
    const hit = path.startsWith(request.journal + "/") && journal.phase === phase && (count === undefined || journal.directories?.length === Number(count));
    if (hit && when === "before") process.exit(70);
    await original(path, value);
    if (hit) process.exit(70);
  });
}
// `window`: { call: "chown" | "chmod", value, entity: "dev:ino" } exits with 70 right after that call (first argument
// `value`) on a handle of that directory, between the two permission calls of a fence or a hand-back.
if (request.window) {
  const probe = await open(".", "r"), prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype[request.window.call];
  prototype[request.window.call] = async function (this: FileHandle, ...args: unknown[]) {
    const result = await original.apply(this, args), info = await this.stat({ bigint: true });
    if (args[0] === request.window.value && `${info.dev}:${info.ino}` === request.window.entity) process.exit(70);
    return result;
  };
}
const crashing = !!(request.crash || request.window);
const scope: MemberScope = { async withMember(_paths, _member, _mode, run) {
  return run({ calls: {}, liveWork: false, protectedPath: () => false, settle: async () => {} });
} };
const archive = () => ({ root: request.groups, state: join(request.groups, "..", "state.sqlite"), archive: join(request.groups, ".reclamation/backup/rm"),
  scope, legacy: true, journal: request.journal });
// Loaded only for reclamation requests: the durable modules make every other child slower to start.
const reclamation = async () => ({ module: await import("../../src/maintenance/reclaim.ts"), options: { root: request.groups,
  state: join(request.groups, "..", "state.sqlite"), directory: request.journal,
  scope: (await import("../../src/durable/maintenance-view.ts")).durableMemberScope, legacy: true } });
let reply: unknown;
try {
  const result = request.kind === "reclaim" ? await reclaimLegacy(request.path, request.proof, request.journal, request.operation)
    : request.kind === "discard" ? await applyArchiveRemoval(archive(), request.id, request.digest)
    : request.kind === "reclaim-preview" ? await reclamation().then(({ module, options }) => module.previewReclamation(options, 0))
    : request.kind === "reclaim-apply" ? await reclamation().then(({ module, options }) => module.applyReclamation(options, request.id, request.digest))
    : await previewArchiveRemoval(archive());
  reply = { ok: true, result: result ?? null };
} catch (error) {
  if (crashing) throw error;
  reply = { ok: false, pending: error instanceof LegacyReclamationPending, message: String(error) };
}
if (crashing) { console.log("finished without reaching the crash point"); process.exit(0); }
console.log(JSON.stringify(reply));
process.exit(0);
