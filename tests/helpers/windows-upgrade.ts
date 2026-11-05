// Native effects are synthetic by default; callers may opt into Git in their isolated repository. No real bot or credentials.
// The real host, deployment lock, immutable runtime, disk journal and local readiness protocol execute together.
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { preflightWindowsUpgrade, runWindowsLifecycle, type WindowsUpgradeInput } from "../../scripts/ops/core/windows-lifecycle.ts";
import { loadDeploymentState } from "../../scripts/ops/core/deployment-state.ts";
import { assessMaintenanceAction, readMaintenanceState } from "../../src/core/maintenance-state.ts";
import { releaseDataResult } from "../../scripts/lib/release-data-protocol.ts";
import type { NativeRunner } from "../../scripts/ops/core/native-process.ts";
import type { OpsResult } from "../../scripts/ops/core/result.ts";
import { tempFixture } from "../helpers/temp.ts";
import { deploymentRuntime } from "../../scripts/ops/core/deployment-runtime.ts";
import { serializeTransactionRecord } from "../../scripts/ops/core/transaction-record.ts";

const source = resolve(import.meta.dir, "../.."), identity = "c".repeat(64);
interface FixtureOptions {
  checkout?: { project: string; original: string; target: string; branch: string; run: NativeRunner };
  beforePreflight?(): Promise<void>;
  refuseStop?: boolean;
  failure?: "main-missing" | "diverged" | "task-missing" | "switch" | "switch-late" | "code" | "install" | "scope-install" | "apply" | "cleanup" | "health" | "commit" | "postcommit" | "dirty-on-apply";
  reuse?: boolean;
  directory?: boolean;
  cleanup?: "apply" | "skip";
}
export async function windowsUpgradeFixture(running: boolean, options: FixtureOptions = {}) {
  const f = await tempFixture("core-windows-upgrade-"), project = options.checkout?.project ?? f.root;
  const original = options.checkout?.original ?? "a".repeat(40), target = options.checkout?.target ?? "b".repeat(40), originalBranch = options.checkout?.branch ?? "main";
  for (const dir of ["data/state", "data/config", ".git", "node_modules"]) mkdirSync(join(project, dir), { recursive: true });
  if (!existsSync(join(project, "package.json"))) writeFileSync(join(project, "package.json"), "{}");
  if (!options.checkout) writeFileSync(join(project, ".git/index"), "synthetic index");
  writeFileSync(join(project, "data/config/directory.json"), '{"format":1,"all":true}');
  const plan = join(project, "plan.json"); writeFileSync(plan, "{}");
  const directoryPlan = join(project, "directory-plan.json"), directoryFile = join(project, "data/config/directory.json");
  if (options.directory) { rmSync(directoryFile); writeFileSync(directoryPlan, '{"format":1,"departments":["100"]}'); }
  const events: string[] = [], results: OpsResult[] = [];
  let head = original, main = original, branch = originalBranch, service = running, snapshot = "", capturedRunning = running, checked = false;
  // supervised: a refused formal start leaves the task Running and the bot unready, as bot-supervisor.ps1 does while it retries.
  let verifyReady = true, loseCommitReply = false, rejectActivation = false, supervised = false, botReady = true;
  let dirty = false, originalDirectory: string | null = null;
  const instance = { instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(): Response {
    const verificationOnly = existsSync(join(project, "data/state/verify-only"));
    return Response.json({ ...instance, service: "mixin-chatbot", version: 1, build: head.slice(0, 12),
      status: (verificationOnly ? !verifyReady || options.failure === "health" : !botReady) ? "starting" : "ready", verificationOnly, port: server.port });
  } });
  writeFileSync(join(project, "data/state/instance.json"), JSON.stringify({ ...instance, port: server.port }));
  const release = join(project, "data/state/release-data.json");
  const native: NativeRunner = async command => {
    const ok = (value = "") => ({ code: 0, stdout: value });
    if (command.command === "git") {
      if (options.checkout) {
        const result = await options.checkout.run(command);
        if (command.args.includes("HEAD^{commit}") && result.code === 0) head = result.stdout.trim();
        if (command.args.includes("checkout") || command.args.includes("merge") || command.args.includes("reset")) events.push("git:effect");
        return result;
      }
      const argv = command.args.slice(5); if (argv[0] === "--literal-pathspecs") argv.shift();
      const verb = argv.shift();
      if (verb === "show-ref") return { code: options.failure === "main-missing" ? 1 : 0, stdout: "" };
      if (verb === "rev-parse") {
        if (argv.includes("--abbrev-ref")) return ok(branch + "\n");
        if (argv.includes("--git-path")) return ok(".git/index\n");
        const ref = argv.at(-1)!.replace(/\^\{commit\}$/, "");
        if (ref === "refs/heads/main" && options.failure === "main-missing") return { code: 1, stdout: "" };
        return ok((ref === "HEAD" ? head : ref === "refs/heads/main" ? main : ref) + "\n");
      }
      if (verb === "merge-base" && options.failure === "diverged" || verb === "diff" && argv.includes("--quiet") && options.reuse === false) return { code: 1, stdout: "" };
      if (verb === "status" && (dirty || options.failure === "switch" || options.failure === "switch-late" && checked)) return ok(" M version.txt\0");
      // The dry run refreshes and reads only its own copy of the index.
      if (verb === "update-index" || verb === "read-tree") expect(command.env?.GIT_INDEX_FILE).toBeTruthy();
      if (["status", "diff", "merge-base", "update-index", "read-tree", "check-ref-format"].includes(verb!)) return ok();
      if (["checkout", "merge", "reset"].includes(verb!)) {
        expect(loadDeploymentState(project)?.execution?.writer?.phase).toBe("prepared");
        events.push("git:" + verb);
        if (verb === "checkout") { branch = argv.at(-1)!; head = branch === "main" ? main : original; }
        else if (verb === "merge") head = main = options.failure === "code" ? "d".repeat(40) : argv.at(-1)!;
        else head = main = argv.at(-1)!;
        return ok();
      }
      throw new Error("Unexpected Git boundary: " + verb);
    }
    if (command.command === "powershell.exe") {
      const request = JSON.parse(Buffer.from(command.args.at(-1)!, "base64").toString("utf8"));
      const effect = command.args.some(value => value.endsWith("windows-deployment-platform.ps1"));
      const action = request.action as string; let value: unknown = null;
      const meta = () => ({ identity, wasRunning: capturedRunning, hasTask: true, dependenciesAttempted: false, dependenciesMoved: false });
      if (effect) {
        events.push("effect:" + action);
        if (action === "capture") {
          snapshot = request.snapshot; capturedRunning = service;
          originalDirectory = existsSync(directoryFile) ? readFileSync(directoryFile, "utf8") : null;
          const dir = join(project, "backup/snapshots", snapshot); mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "deployment.xml"), "fixture native metadata"); value = meta();
        } else if (action === "read") {
          value = meta(); if (!checked) { checked = true; await options.beforePreflight?.(); }
        } else if (action === "stop") {
          if (options.refuseStop) throw new Error("synthetic stop refused"); service = false;
        }
        else if (action === "restore-configuration") {
          if (originalDirectory === null) rmSync(directoryFile, { force: true }); else writeFileSync(directoryFile, originalDirectory);
        } else if (!["restore-task", "restore-dependencies", "cleanup", "save-dependencies"].includes(action)) throw new Error("Unexpected native effect");
      } else if (action === "inspect") value = { identity, owned: true, state: options.failure === "task-missing" ? "absent" : service ? "running" : "stopped", rawState: service ? "Running" : "Ready" };
      else if (action === "start") {
        const verification = existsSync(join(project, "data/state/verify-only"));
        expect(assessMaintenanceAction(readMaintenanceState(project), verification ? "verify" : "service").allowed).toBe(true);
        events.push(verification ? "start:verify" : head === target ? "start:target" : "start:original");
        const refused = !verification && head === target && (rejectActivation || options.failure === "postcommit");
        if (refused && !supervised) throw new Error("synthetic activation refusal");
        service = true; botReady = !refused;
      } else throw new Error("Unexpected service effect");
      return ok(JSON.stringify({ protocol: "mixin-platform", version: 1, action, ok: true, value }));
    }
    if (command.command === process.execPath && command.args.some(value => value.endsWith("data-current.ts"))) {
      const script = command.args.findIndex(value => value.endsWith("data-current.ts")), action = command.args[script + 1]!;
      expect(command.args[script]).toContain("source-"); expect(command.args[script]).not.toBe(join(project, "scripts/runtime/data-current.ts"));
      expect(command.env?.APP_BUILD).toBe(target.slice(0, 12));
      expect(loadDeploymentState(project)?.execution?.writer?.phase).toBe("prepared");
      events.push("data:" + action);
      if (action === "apply" && options.failure === "dirty-on-apply") dirty = true;
      if (action === "commit" && options.failure === "commit") return { code: 1, stdout: JSON.stringify(releaseDataResult(action, 1)) };
      if (action === "apply" || action === "commit") writeFileSync(release, JSON.stringify({ format: 1, deployment: snapshot,
        phase: action === "apply" ? "prepared" : "committed", previous: null }));
      else if (action === "rollback") rmSync(release, { force: true }); else throw new Error("Unexpected data effect");
      if (action === "commit" && loseCommitReply) throw new Error("synthetic commit reply lost");
      if (action === "apply" && (options.failure === "apply" || options.failure === "dirty-on-apply")) return { code: 1, stdout: JSON.stringify(releaseDataResult(action, 1)) };
      return ok(JSON.stringify(releaseDataResult(action, 0)));
    }
    if (command.command === process.execPath && command.args[0] === "install") {
      expect(service).toBe(false); events.push("dependencies:install"); return { code: options.failure === "install" ? 1 : 0, stdout: "" };
    }
    for (const tool of ["directory-scope", "revision-cleanup"]) {
      const index = command.args.findIndex(value => value.endsWith(tool + ".ts")); if (index < 0) continue;
      const action = command.args[index + 1]!; expect(service).toBe(false); expect(loadDeploymentState(project)?.execution?.writer?.phase).toBe("prepared");
      events.push(tool + ":" + action); let code = 0;
      if (tool === "directory-scope") {
        const plan = command.args[command.args.indexOf("--plan") + 1]!;
        expect(plan).toContain("backup"); writeFileSync(directoryFile, readFileSync(plan)); code = options.failure === "scope-install" ? 1 : 0;
      } else {
        const fail = action === "apply" && options.failure === "cleanup";
        writeFileSync(join(project, "data/state/revision-cleanup.json"), JSON.stringify({ version: 2, run: "fixture-cleanup", databases: [],
          interval: 64, startedAt: new Date().toISOString(), state: fail ? "stopped" : action === "abandon" ? "abandoned" : "finished",
          ...(fail ? { current: { space: "direct" } } : {}) })); code = fail ? 3 : 0;
      }
      return { code, stdout: JSON.stringify({ protocol: "mixin-maintenance", version: 1, command: action,
        outcome: code === 3 ? "stopped" : code ? "failed" : "success", result: null }) };
    }
    throw new Error("Unexpected command boundary: " + command.command);
  };
  const input: WindowsUpgradeInput = { original, target, branch: originalBranch, plan, cleanup: options.cleanup ?? "skip", ...(options.directory ? { directoryPlan } : {}) };
  const run = (value = input) => runWindowsLifecycle(value, { project, source, native, output: () => {}, readyTimeoutMs: 25,
    async verify() {}, async finish(result) { results.push(result); } });
  return { project, plan, input, run, events, results, get running() { return service; }, get head() { return head; },
    preflight: (value = input) => preflightWindowsUpgrade(value, { project, source, native }),
    async pending(phase?: "prepared" | "committed") {
      originalDirectory = existsSync(directoryFile) ? readFileSync(directoryFile, "utf8") : null;
      snapshot = "deploy-" + randomUUID().replaceAll("-", "");
      const dir = join(project, "backup/snapshots", snapshot); mkdirSync(dir, { recursive: true });
      const pinned = deploymentRuntime(project, source, null);
      writeFileSync(join(dir, "transaction"), serializeTransactionRecord({ format: "2", operation: "upgrade", snapshot, target_sha: target,
        original_sha: original, original_branch: originalBranch, original_workspace_root: "", target_workspace_root: "", was_running: running ? "1" : "0",
        bot_port: "1011", reconfigure_ai: "0" }));
      writeFileSync(join(dir, "deployment.xml"), "fixture native metadata"); writeFileSync(join(dir, "data-plan.json"), "{}");
      writeFileSync(join(dir, "revision-cleanup"), "skip\n"); writeFileSync(join(dir, "host-runtime"), pinned.digest + "\n");
      writeFileSync(join(project, "data/state/upgrade-transaction"), snapshot + "\n");
      delete input.plan; delete input.cleanup; delete input.directoryPlan; input.command = "resume";
      if (phase) {
        service = false; head = main = target;
        writeFileSync(release, JSON.stringify({ format: 1, deployment: snapshot, phase, previous: null }));
      }
    },
    dirty() { dirty = true; },
    breakVerification() { verifyReady = false; }, loseCommit() { loseCommitReply = true; rejectActivation = true; },
    refuseActivationSupervised() { rejectActivation = true; supervised = true; },
    allowActivation() { rejectActivation = false; }, async cleanup() { await server.stop(true); await f.cleanup(); } };
}

