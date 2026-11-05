// Linux only. The Docker CLI boundary is synthetic: one fake answers the service daemon and the separate task daemon, each
// behind a real Unix socket so the ownership checks run. Git, cp/mv, the process supervisor, the deployment lock, the pinned
// runtime, the disk journal, the local readiness protocol and the runtime and configuration installs are real. No real
// container, image or credential.
import { expect } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { chownSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configurationSnapshot } from "../../scripts/config/configuration-form.ts";
import { installConfigurationStage, parseConfigurationStage, serializeConfigurationStage, stageName, type StagedKind } from "../../scripts/config/configuration-stage.ts";
import { installRuntimeValues } from "../../scripts/config/runtime-settings.ts";
import { RUNTIME_VALUES_FILE, runtimeDigest, serializeRuntimeValues } from "../../scripts/config/runtime-values.ts";
import { DEPLOY_CHOICES_FILE, type DeployChoices, type PlatformStageFile } from "../../scripts/ops/core/deploy-stage.ts";
import type { DeployInput } from "../../scripts/ops/core/deployment-host.ts";
import { candidateProjectId, serializeCandidateRecord, serializeServiceUser, serializeTaskRuntime, type CandidateRecord } from "../../scripts/ops/core/docker-deployment.ts";
import { preflightDockerDeploy, preflightDockerUpgrade, runDockerLifecycle, type DockerInput, type DockerUpgradeInput } from "../../scripts/ops/core/docker-lifecycle.ts";
import { loadDeploymentState } from "../../scripts/ops/core/deployment-state.ts";
import { runNative, type NativeCommand, type NativeOutput, type NativeResult, type NativeRunner } from "../../scripts/ops/core/native-process.ts";
import { releaseDataResult } from "../../scripts/lib/release-data-protocol.ts";
import { PROTOCOL, PROTOCOL_VERSION } from "../../scripts/lib/maintenance-protocol.ts";
import type { OpsResult } from "../../scripts/ops/core/result.ts";
import { tempFixture } from "./temp.ts";

const source = resolve(import.meta.dir, "../..");
const hex = (bytes: number) => randomBytes(bytes).toString("hex"), imageId = () => "sha256:" + hex(32);
const tagName = (reference: string) => /:[^/]*$/.test(reference) ? reference : reference + ":latest";
const VALUE_FLAGS = new Set(["--user", "--env", "--mount", "--publish", "--network", "--restart", "--stop-timeout", "--name", "--memory", "--memory-swap",
  "--cpus", "--pids-limit", "--tmpfs", "--security-opt", "--cap-drop", "--log-driver", "--log-opt", "--label", "--entrypoint", "--workdir", "--attach"]);
const BOOLEAN_FLAGS = new Set(["--init", "--read-only", "--interactive"]);

/** What a deployment's wizards answer before the stop. Fixture values, not credentials. */
export const APP = '{"appId":"fixture-app","appSecret":"fixture-secret","environment":"production"}\n';
export const MODELS = { models: '{"providers":{"fixture":{}}}\n', settings: '{"defaultProvider":"fixture"}\n' };
export const DIRECTORY = '{"format":1,"all":true}';

interface Mount { Type: string; Source: string; Destination: string; RW: boolean }
interface Container {
  Id: string;
  Name: string;
  Image: string;
  Config: { User: string; Env: string[]; Labels: Record<string, string>; Entrypoint: string[] | null; Cmd: string[]; OpenStdin: boolean; StdinOnce: boolean; Tty: boolean };
  HostConfig: { Privileged: boolean; ReadonlyRootfs: boolean; NetworkMode: string; RestartPolicy: { Name: string }; AutoRemove: boolean };
  Mounts: Mount[];
  State: { Status: string; Running: boolean; Paused: boolean; Restarting: boolean; ExitCode: number };
  /** The verify-only flag this instance saw when it started, like the service reads it once at startup. */
  verification?: boolean;
}
interface Image { Id: string; Os: string; Architecture: string; Config: { Labels: Record<string, string>; Env: string[] } }
class Daemon {
  readonly containers = new Map<string, Container>();
  readonly images = new Map<string, Image>();
  readonly tags = new Map<string, string>();
  constructor(public id: string) {}
  container(reference: string) { return this.containers.get(reference) ?? [...this.containers.values()].find(c => c.Name === "/" + reference); }
  image(reference: string) { return this.images.get(/^sha256:[a-f0-9]{64}$/.test(reference) ? reference : this.tags.get(tagName(reference)) ?? ""); }
  references(id: string) { return [...this.tags].filter(([, image]) => image === id).map(([tag]) => tag); }
}

function parseMount(specification: string): Mount {
  const parts = new Map(specification.split(",").map(part => { const at = part.indexOf("="); return at < 0 ? [part, "true"] : [part.slice(0, at), part.slice(at + 1)]; }));
  return { Type: parts.get("type")!, Source: parts.get("src") ?? parts.get("source")!, Destination: parts.get("dst") ?? parts.get("target")!, RW: !parts.has("readonly") };
}
function parseCreate(args: string[]) {
  const values = new Map<string, string[]>(), flags = new Set<string>();
  let index = 0;
  for (; index < args.length && args[index]!.startsWith("--"); index++) {
    const name = args[index]!;
    if (BOOLEAN_FLAGS.has(name)) { flags.add(name); continue; }
    if (!VALUE_FLAGS.has(name)) throw new Error("fixture docker: unknown create flag " + name);
    values.set(name, [...values.get(name) ?? [], args[++index]!]);
  }
  return { values, flags, image: args[index]!, command: args.slice(index + 1) };
}
const render = (format: string, image: Image, daemon: Daemon) => format.replaceAll("{{.Id}}", image.Id)
  .replace(/\{\{index \.Config\.Labels "([^"]+)"\}\}/g, (_, key: string) => image.Config.Labels[key] ?? "")
  .replaceAll("{{len .RepoTags}}", String(daemon.references(image.Id).length)).replaceAll("{{len .RepoDigests}}", "0");

/** interrupt: the entry dies right after publishing the transaction, before the stop (the first image lookup then throws). task-cleanup: the separate task daemon cannot list its images. abandon: the first revision abandon fails and leaves its journal as it was. candidate-loop: the formal candidate start keeps failing under the restart policy (restarting, never ready) until the failure is removed. */
export type DockerFailure = "verification-health" | "verification-exit" | "apply" | "commit-reply" | "restore-data" | "layout" | "cleanup" | "interrupt" | "task-cleanup" | "abandon" | "candidate-loop";
export interface DockerFixtureOptions {
  failures?: DockerFailure[];
  directory?: boolean;
  cleanup?: "apply" | "skip";
  /** The service daemon doubles as the task daemon, so nothing is reclaimed there. */
  sharedDaemon?: boolean;
}
/** A deployment of the current checkout: over the existing service container, or without `original` the first one on an empty directory. */
export interface DockerDeployOptions extends Pick<DockerFixtureOptions, "failures" | "sharedDaemon"> {
  original?: boolean;
  /** Whether the original container runs. */
  running?: boolean;
  /** Without a Git checkout (an unpacked release) the candidate names no commit. */
  git?: boolean;
}
/** What the deploy entry answers and records before the stop. Undefined takes the default, null leaves the file out. */
export interface DeployStageOptions {
  target?: string;
  port?: number;
  workspace?: string;
  cleanup?: "apply" | "skip";
  /** Supported keys besides BOT_PORT. */
  runtime?: Record<string, string>;
  /** A first deployment answers both configurations and the directory scope and previews after the stop; a redeployment keeps its configuration and previews before. */
  app?: string | null;
  models?: { models: string; settings: string } | null;
  directory?: string | null;
  plan?: string | null;
  /** The platform records as written; a string replaces the generated record. */
  platform?: Partial<Record<PlatformStageFile, string | null>>;
}

/** The fake Docker, the real host around it and one project: an upgrade's (`deploy` unset) or a deployment's. */
async function dockerHarness(running: boolean, options: DockerFixtureOptions, deploy?: { original: boolean; git: boolean }) {
  const f = await tempFixture(deploy ? "core-docker-deploy-" : "core-docker-upgrade-"), project = join(f.root, "project"), prepared = join(f.root, "prepared");
  mkdirSync(project); mkdirSync(prepared);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const checkout = !deploy || deploy.git, withOriginal = !deploy || deploy.original;
  if (checkout) {
    git("init", "-q", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "fixture"); git("config", "commit.gpgsign", "false");
    writeFileSync(join(project, ".gitignore"), "data/\nbackup/\nlogs/\n.console/\n"); writeFileSync(join(project, "version.txt"), "original\n");
    git("add", "-A"); git("commit", "-q", "-m", "original");
    // The target also adds a file, so a local file on that path is a switch conflict.
    git("checkout", "-q", "-b", "next"); writeFileSync(join(project, "version.txt"), "target\n"); writeFileSync(join(project, "release-notes.md"), "target\n");
    git("add", "-A"); git("commit", "-q", "-m", "target"); git("checkout", "-q", "main");
  }
  const original = checkout ? git("rev-parse", "main") : "", target = checkout ? git("rev-parse", "next") : "";
  // An upgrade builds the target commit; a deployment builds the checkout as it is (HEAD stays on main).
  const built = deploy ? original : target;
  if (withOriginal) for (const directory of ["data/state", "data/config"]) mkdirSync(join(project, directory), { recursive: true });
  const data = join(realpathSync(project), "data"), directoryFile = join(project, "data/config/directory.json");
  const plan = join(prepared, "data-plan.json"), directoryPlan = join(prepared, "directory-plan.json");
  writeFileSync(plan, "{}");
  if (withOriginal) writeFileSync(directoryFile, DIRECTORY);
  if (options.directory) { rmSync(directoryFile); writeFileSync(directoryPlan, '{"format":1,"departments":["100"]}'); }
  if (deploy?.original) {
    // A redeployment's original runs with a complete configuration.
    mkdirSync(join(project, "data/runtime/pi"), { recursive: true });
    writeFileSync(join(project, "data/config/app-bot.json"), APP); writeFileSync(join(project, "data/config/models.json"), MODELS.models);
    writeFileSync(join(project, "data/runtime/pi/settings.json"), MODELS.settings); writeFileSync(join(project, "data/state/bot-port"), "1011");
  }

  // Rootless runs the service as the 0:0 mapped to the operator; rootful as its own UID, which then owns the task socket.
  const rootless = process.geteuid!() !== 0, user = rootless ? "0:0" : "1001:1001";
  const mainSocket = join(f.root, "d.sock"), taskSocket = join(f.root, "t.sock"), mainEndpoint = "unix://" + mainSocket, taskEndpoint = "unix://" + taskSocket;
  const listeners = [mainSocket, taskSocket].map(path => Bun.listen({ unix: path, socket: { data() {} } }));
  if (!rootless) chownSync(taskSocket, 1001, 1001);
  const main = new Daemon("fixture-main-daemon"), task = options.sharedDaemon ? main : new Daemon("fixture-task-daemon");

  const projectId = candidateProjectId(project), operationId = hex(8), originalImage = imageId(), candidateImage = imageId(), keptImage = imageId(), foreignImage = imageId();
  const labels = (revision: string, operation: string, owner = projectId, from = "commit") => ({ "org.opencontainers.image.revision": revision, "org.mixin-chatbot.project": owner,
    "org.mixin-chatbot.operation": operation, "org.mixin-chatbot.source": from });
  const image = (id: string, values: Record<string, string>): Image => ({ Id: id, Os: "linux", Architecture: "amd64",
    Config: { Labels: values, Env: [`APP_BUILD=${values["org.opencontainers.image.revision"]!.slice(0, 12)}`] } });
  const candidate: CandidateRecord = { format: "1", source: deploy ? "workspace" : "commit", target_sha: built, image_id: candidateImage,
    image_tag: `mixin-chatbot:candidate-${projectId}-${operationId}`, daemon_id: main.id, project_id: projectId, operation_id: operationId };
  for (const daemon of new Set([main, task])) {
    if (withOriginal) daemon.images.set(originalImage, image(originalImage, labels(original, hex(8))));
    daemon.images.set(candidateImage, image(candidateImage, labels(built, operationId, projectId, candidate.source)));
  }
  if (withOriginal) main.tags.set("mixin-chatbot:latest", originalImage);
  main.tags.set(candidate.image_tag, candidateImage);
  // What a successful operation may reclaim on a separate task daemon: only the old image, never a named or foreign one.
  task.images.set(keptImage, image(keptImage, labels(original, hex(8)))); task.tags.set("kept:named", keptImage);
  task.images.set(foreignImage, image(foreignImage, labels(original, hex(8), "0".repeat(12))));

  const service = (name: string, imageRef: string, mounts: Mount[], state: Container["State"]): Container => ({ Id: hex(32), Name: "/" + name, Image: imageRef,
    Config: { User: user, Env: [], Labels: {}, Entrypoint: null, Cmd: [], OpenStdin: false, StdinOnce: false, Tty: false },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: rootless ? "bridge" : "host", RestartPolicy: { Name: "unless-stopped" }, AutoRemove: false }, Mounts: mounts, State: state });
  const stopped = { Status: "exited", Running: false, Paused: false, Restarting: false, ExitCode: 0 }, up = { ...stopped, Status: "running", Running: true };
  const originalContainer = withOriginal ? service("mixin-chatbot", originalImage, [{ Type: "bind", Source: data, Destination: "/app/data", RW: true }], running ? up : stopped) : undefined;
  if (originalContainer) main.containers.set(originalContainer.Id, originalContainer);

  const failures = new Set(options.failures ?? []), events: string[] = [], unexpected: string[] = [], outputs: string[] = [], results: OpsResult[] = [], reclaims: boolean[] = [];
  const role = (c: Container) => c.Image === candidateImage ? "candidate" : "original", maintenance = (c: Container) => c.Name.startsWith("/mixin-maint-");
  const instances = () => [...main.containers.values()].filter(c => c.State.Running && !maintenance(c));
  const instance = { instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(): Response {
    const active = instances();
    if (active.length !== 1) return new Response("no instance", { status: 503 });
    const current = active[0]!, verificationOnly = !!current.verification;
    return Response.json({ ...instance, service: "mixin-chatbot", version: 1, build: (role(current) === "candidate" ? built : original).slice(0, 12),
      status: verificationOnly && failures.has("verification-health") || current.State.Restarting ? "starting" : "ready", verificationOnly, port: server.port });
  } });
  // The service writes its identity when it starts; the original of an upgrade or redeployment already did.
  const instanceFile = join(project, "data/state/instance.json"), instanceText = JSON.stringify({ ...instance, port: server.port });
  if (withOriginal) writeFileSync(instanceFile, instanceText);

  const hostPath = (path: string) => path.startsWith("/app/") ? join(project, path.slice(5)) : path;
  const writeRelease = (deployment: string, phase: "prepared" | "committed") => writeFileSync(join(project, "data/state/release-data.json"),
    JSON.stringify({ format: 1, deployment, phase, previous: null }, null, 2) + "\n");
  const maintenanceReply = (command: string, code: number) => ({ code, stdout: JSON.stringify({ protocol: PROTOCOL, version: PROTOCOL_VERSION, command,
    outcome: code === 3 ? "stopped" : code ? "failed" : "success", result: null }) });
  /** What the target release's tool does inside its maintenance container. `lost` drops the reply after the effect. */
  const runTool = async (c: Container): Promise<NativeResult & { lost?: boolean }> => {
    expect(c.Image).toBe(candidateImage); expect(c.Config.User).toBe(user); expect(c.HostConfig.NetworkMode).toBe("none");
    expect(instances()).toEqual([]);
    const writer = loadDeploymentState(project)?.execution?.writer;
    expect(writer).toMatchObject({ kind: "docker", phase: "starting", container: c.Id });
    const [flag, verb, script, ...args] = c.Config.Cmd, action = args[0];
    expect([flag, verb]).toEqual(["--no-env-file", "run"]);
    const option = (name: string) => args[args.indexOf(name) + 1], deployment = (writer as { deployment: { id: string } }).deployment.id;
    const name = script!.replace(/^.*\/|\.ts$/g, "");
    // The installs run for real: the second one of an interrupted attempt finds its result in place.
    const install = async (label: string, command: string, work: () => Promise<boolean>) => {
      try { events.push(label + (await work() ? "" : ":in-place")); return maintenanceReply(command, 0); }
      catch (error) { events.push(label + ":failed"); outputs.push((error as Error).message + "\n"); return maintenanceReply(command, 1); }
    };
    if (script === "scripts/config/runtime-settings.ts") {
      expect(args).toEqual(["--values", option("--values"), "--json"]);
      return install(`${name}:values`, "values", () => installRuntimeValues(hostPath(option("--values")!), join(project, "data/config/runtime.json")));
    }
    if (script === "scripts/config/configuration-install.ts") {
      const kind = option("--kind") as StagedKind;
      expect(args).toEqual(["--kind", kind, "--stage", option("--stage"), "--json"]);
      return install(`${name}:${kind}`, "install", () => installConfigurationStage(project, parseConfigurationStage(readFileSync(hostPath(option("--stage")!), "utf8"), kind)));
    }
    events.push(`${name}:${action}`);
    if (script === "scripts/runtime/data-current.ts") {
      expect(option("--deployment")).toBe(deployment);
      const reply = (code: number) => ({ code, stdout: JSON.stringify(releaseDataResult(action!, code)) });
      // Without a plan from before the stop, the target release previews into the snapshot as the service user.
      if (action === "preview") { expect(existsSync(hostPath(option("--plan")!))).toBe(false); writeFileSync(hostPath(option("--plan")!), "{}\n"); return reply(0); }
      // Only the apply reads the plan; a first deployment rolled back before its preview has none.
      if (action !== "rollback") expect(existsSync(hostPath(option("--plan")!))).toBe(true);
      if (action === "apply") { if (failures.has("apply")) return reply(1); writeRelease(deployment, "prepared"); return reply(0); }
      if (action === "commit") { writeRelease(deployment, "committed"); return { ...reply(0), lost: failures.delete("commit-reply") }; }
      expect(action).toBe("rollback");
      if (failures.delete("restore-data")) return reply(1);
      rmSync(join(project, "data/state/release-data.json"), { force: true }); return reply(0);
    }
    if (script === "scripts/runtime/revision-cleanup.ts") {
      if (action === "abandon" && failures.delete("abandon")) return maintenanceReply(action, 1);
      const failed = action === "apply" && failures.has("cleanup");
      writeFileSync(join(project, "data/state/revision-cleanup.json"), JSON.stringify({ version: 2, run: "fixture-cleanup", databases: [], interval: 64, startedAt: new Date().toISOString(),
        state: failed ? "stopped" : action === "abandon" ? "abandoned" : "finished", ...(failed ? { current: { space: "direct" } } : {}) }, null, 2) + "\n");
      return maintenanceReply(action!, failed ? 3 : 0);
    }
    if (script === "scripts/config/directory-scope.ts") { writeFileSync(directoryFile, readFileSync(hostPath(option("--plan")!))); return maintenanceReply(action!, 0); }
    if (script === "scripts/runtime/task-deployment.ts") {
      expect(option("--image")).toBe(candidateImage); expect(option("--data")).toBe(data);
      writeFileSync(join(project, "data/config/task-deployment.json"), JSON.stringify({ image: candidateImage }));
      return { code: 0, stdout: "" };
    }
    throw new Error("fixture docker: unexpected tool " + script);
  };

  const docker = async (command: NativeCommand, output?: NativeOutput): Promise<NativeResult> => {
    expect(command.args[0]).toBe("--host"); expect(command.env?.DOCKER_HOST).toBeUndefined(); expect(command.env?.DOCKER_CONTEXT).toBeUndefined();
    const daemon = command.args[1] === mainEndpoint ? main : command.args[1] === taskEndpoint ? task : null, args = command.args.slice(2);
    if (!daemon) throw new Error("fixture docker: unexpected endpoint " + command.args[1]);
    const ok = (stdout = "") => ({ code: 0, stdout });
    const refuse = (message: string) => { output?.(message + "\n", "stderr"); return { code: 1, stdout: "" }; };
    const missingContainer = (reference: string) => refuse("Error response from daemon: No such container: " + reference);
    const action = ["container", "image"].includes(args[0]!) ? `${args[0]} ${args[1]}` : args[0]!, last = args.at(-1)!;
    if (action === "info") return ok(JSON.stringify({ ID: daemon.id, SecurityOptions: ["name=seccomp,profile=builtin", ...(daemon === task || rootless ? ["name=rootless"] : [])] }) + "\n");
    if (action === "version") return ok('"amd64"\n');
    if (action === "container inspect") { const c = daemon.container(last); return c ? ok(JSON.stringify([c])) : missingContainer(last); }
    if (action === "container ls") {
      const name = new RegExp(args[args.indexOf("--filter") + 1]!.replace(/^name=/, ""));
      return ok([...daemon.containers.values()].filter(c => name.test(c.Name)).map(c => c.Id + "\n").join(""));
    }
    if (action === "container create") {
      const { values, flags, image: reference, command: cmd } = parseCreate(args.slice(2)), name = values.get("--name")?.[0];
      if (!name || !daemon.image(reference)) { unexpected.push(args.join(" ")); return refuse("fixture docker: invalid create"); }
      if (daemon.container(name)) return refuse(`Error response from daemon: Conflict. The container name "/${name}" is already in use`);
      const c: Container = { Id: hex(32), Name: "/" + name, Image: daemon.image(reference)!.Id,
        Config: { User: values.get("--user")?.[0] ?? "", Env: values.get("--env") ?? [], Entrypoint: values.get("--entrypoint") ?? null, Cmd: cmd, Tty: false,
          Labels: Object.fromEntries((values.get("--label") ?? []).map(label => [label.slice(0, label.indexOf("=")), label.slice(label.indexOf("=") + 1)])),
          OpenStdin: flags.has("--interactive"), StdinOnce: flags.has("--interactive") },
        HostConfig: { Privileged: false, ReadonlyRootfs: flags.has("--read-only"), NetworkMode: values.get("--network")?.[0] ?? "bridge",
          RestartPolicy: { Name: values.get("--restart")?.[0] ?? "no" }, AutoRemove: false },
        Mounts: (values.get("--mount") ?? []).map(parseMount), State: { ...stopped, Status: "created" } };
      daemon.containers.set(c.Id, c);
      if (!maintenance(c)) {
        events.push("create:" + role(c)); expect(c.Config.User).toBe(user);
        for (const [destination, path] of [["/app/data", data], ["/run/mixin-task/docker.sock", taskSocket]] as const)
          expect(c.Mounts.filter(mount => mount.Destination === destination).map(mount => mount.Source)).toEqual([path]);
      }
      return ok(c.Id + "\n");
    }
    if (action === "container start") {
      const c = daemon.container(last);
      if (!c) return missingContainer(last);
      if (maintenance(c)) {
        expect(args[2]).toBe("--attach");
        c.State = { ...up };
        const { lost, ...reply } = await runTool(c);
        c.State = { ...stopped, ExitCode: reply.code };
        if (lost) throw new Error("synthetic: the attach client lost the reply");
        return reply;
      }
      if (c.State.Running) return ok(last + "\n");
      c.verification = existsSync(join(project, "data/state/verify-only"));
      events.push(role(c) === "original" ? "start:original" : c.verification ? "start:verification" : "start:candidate");
      c.State = c.verification && failures.has("verification-exit") ? { ...stopped, ExitCode: 1 }
        : !c.verification && role(c) === "candidate" && failures.has("candidate-loop") ? { ...up, Status: "restarting", Restarting: true } : { ...up };
      if (c.State.Running && !existsSync(instanceFile)) writeFileSync(instanceFile, instanceText);
      return ok(last + "\n");
    }
    if (action === "container stop") {
      const c = daemon.container(last);
      if (!c) return missingContainer(last);
      if (!maintenance(c)) events.push("stop:" + role(c));
      c.State = { ...stopped }; return ok(last + "\n");
    }
    if (action === "container rename") {
      const c = daemon.container(args[2]!);
      if (!c) return missingContainer(args[2]!);
      if (daemon.container(last)) return refuse(`Error response from daemon: Conflict. The container name "/${last}" is already in use`);
      events.push(`rename:${role(c)}:${last.replace(/-\d+-[a-f0-9]+$/, "")}`); c.Name = "/" + last; return ok();
    }
    if (action === "container rm") {
      const c = daemon.container(last);
      if (!c) return missingContainer(last);
      if (c.State.Running && !args.includes("--force")) return refuse("Error response from daemon: cannot remove a running container");
      if (!maintenance(c)) events.push("rm:" + role(c));
      daemon.containers.delete(c.Id); return ok(last + "\n");
    }
    if (action === "logs") return ok("fixture: the instance exited during verification\n");
    if (action === "image inspect") {
      if (existsSync(join(project, "data/state/deploy-transaction")) && failures.delete("interrupt")) throw new Error("synthetic: the entry died after publishing the transaction");
      const found = daemon.image(last), format = args[2] === "--format" ? args[3] : undefined;
      if (!found) return refuse("Error response from daemon: No such image: " + last);
      return ok(format === undefined ? JSON.stringify([{ ...found, RepoTags: daemon.references(found.Id), RepoDigests: [] }]) : render(format, found, daemon) + "\n");
    }
    if (action === "image tag") {
      const found = daemon.image(args[2]!);
      if (!found) return refuse("Error response from daemon: No such image: " + args[2]);
      events.push(`tag:${tagName(last)}:${found.Id === candidateImage ? "candidate" : "original"}`); daemon.tags.set(tagName(last), found.Id); return ok();
    }
    if (action === "image rm") {
      const found = daemon.image(last);
      if (!found) return refuse("Error response from daemon: No such image: " + last);
      if (last.startsWith("sha256:")) {
        if (daemon.references(last).length) return refuse("Error response from daemon: image is referenced in repositories");
        daemon.images.delete(last); return ok();
      }
      daemon.tags.delete(tagName(last));
      if (!daemon.references(found.Id).length && ![...daemon.containers.values()].some(c => c.Image === found.Id)) daemon.images.delete(found.Id);
      return ok();
    }
    if (action === "image ls") {
      if (daemon === task) {
        // Whether the transaction was still open when the images were listed for reclaiming.
        reclaims.push(existsSync(join(project, "data/state/deploy-transaction")));
        if (failures.has("task-cleanup")) return refuse("fixture: the task daemon cannot list images");
      }
      const [key, value] = args[args.indexOf("--filter") + 1]!.replace(/^label=/, "").split("=") as [string, string];
      return ok([...daemon.images.values()].filter(i => i.Config.Labels[key] === value).map(i => i.Id + "\n").join(""));
    }
    if (action === "ps") {
      const ancestor = args[args.indexOf("--filter") + 1]!.replace(/^ancestor=/, "");
      return ok([...daemon.containers.values()].filter(c => c.Image === ancestor).map(c => c.Id + "\n").join(""));
    }
    if (action === "run") {
      expect(args).toContain("scripts/runtime/layout-check.ts"); expect(args).toContain(candidateImage); events.push("layout-check");
      return failures.has("layout") ? refuse("fixture: workspace boundary changed") : ok();
    }
    unexpected.push(args.join(" ")); return refuse("fixture docker: unexpected command");
  };
  /** Git's checks and plain copies skip the supervisor for speed; every journaled writer takes the real one. */
  const direct: NativeRunner = async (command, output) => {
    const child = Bun.spawn([command.command, ...command.args], { cwd: command.cwd, env: command.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (stderr) output?.(stderr, "stderr");
    return { code, stdout };
  };
  const native: NativeRunner = async (command, output) => {
    if (command.command === "docker") return docker(command, output);
    if (command.command === "git") {
      const verb = command.args.slice(5).find(value => !value.startsWith("-"))!;
      if (["checkout", "merge", "reset"].includes(verb)) { expect(command.reapReceipt).toBeDefined(); events.push("git:" + verb); }
    }
    return command.reapReceipt ? runNative(command, output) : direct(command, output);
  };

  const environment = { DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  process.env.DOCKER_HOST = mainEndpoint; delete process.env.DOCKER_CONTEXT;
  const settings = { project, source, native, output: (text: string) => { outputs.push(text); }, readyTimeoutMs: 1500, async verify() {}, async finish(result: OpsResult) { results.push(result); } };
  return { root: f.root, project, prepared, data, original, target, built, user, plan, settings, events, unexpected, outputs, results, reclaims, main, task, failures, directoryFile, directoryPlan,
    candidate, originalContainer, originalImage, candidateImage, keptImage, foreignImage, taskEndpoint, native,
    lifecycle: (input: DockerInput, overrides: Partial<typeof settings> = {}) => runDockerLifecycle(input, { ...settings, ...overrides }),
    head: () => git("rev-parse", "HEAD"), branch: () => git("rev-parse", "--abbrev-ref", "HEAD"), mainRef: () => git("rev-parse", "refs/heads/main"),
    async cleanup() {
      for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      for (const listener of listeners) listener.stop(true);
      await server.stop(true); await f.cleanup();
    } };
}

export async function dockerUpgradeFixture(running: boolean, options: DockerFixtureOptions = {}) {
  const h = await dockerHarness(running, options), originalContainer = h.originalContainer!;
  const candidateFile = join(h.prepared, "candidate-image"), factsFile = join(h.prepared, "upgrade-facts");
  writeFileSync(candidateFile, serializeCandidateRecord(h.candidate));
  const facts = { format: "1", container: originalContainer.Id, user: h.user, image: h.originalImage, data: h.data, main: h.original, endpoint: h.taskEndpoint, daemon: h.task.id };
  const writeFacts = (values: Record<string, string> = facts) => writeFileSync(factsFile, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  writeFacts();
  writeFileSync(join(h.project, "data/state/task-runtime"), serializeTaskRuntime({ endpoint: h.taskEndpoint, daemon: h.task.id }));
  const { original, target, project, native } = h;
  const input: DockerUpgradeInput = { original, target, branch: "main", plan: h.plan, cleanup: options.cleanup ?? "skip", candidate: candidateFile, facts: factsFile,
    ...(options.directory ? { directoryPlan: h.directoryPlan } : {}) };
  const recovery = (command: "resume" | "rollback"): DockerUpgradeInput => ({ original, target, branch: "main", command, ...(command === "rollback" ? { rollback: true } : {}) });
  type Overrides = Parameters<typeof h.lifecycle>[1];
  return { ...h, originalContainer, input, facts, candidateFile, writeFacts,
    run: (value: DockerUpgradeInput = input, overrides: Overrides = {}) => h.lifecycle(value, overrides),
    resume: (overrides: Overrides = {}) => h.lifecycle(recovery("resume"), overrides),
    rollback: (overrides: Overrides = {}) => h.lifecycle(recovery("rollback"), overrides),
    preflight: () => preflightDockerUpgrade({ original, target, branch: "main", command: "update" }, { project, source, native }) };
}

export async function dockerDeployFixture(options: DockerDeployOptions = {}) {
  const h = await dockerHarness(options.running ?? false, options, { original: options.original ?? false, git: options.git ?? true });
  const first = !h.originalContainer;
  /** The original container as the entry saw it; all empty for a first deployment. */
  const facts = { format: "1", container: h.originalContainer?.Id ?? "", image: first ? "" : h.originalImage, data: first ? "" : h.data };
  const platform: Record<Exclude<PlatformStageFile, "windows-tools">, string> = { "candidate-image": serializeCandidateRecord(h.candidate),
    "service-user": serializeServiceUser({ format: "1", user: h.user, source: first ? "default" : "container" }),
    "task-runtime": serializeTaskRuntime({ endpoint: h.taskEndpoint, daemon: h.task.id }),
    facts: Object.entries(facts).map(([key, value]) => `${key}=${value}\n`).join("") };
  const current = (relative: string) => existsSync(join(h.project, relative)) ? readFileSync(join(h.project, relative), "utf8") : null;
  const staged = (kind: StagedKind, files: Record<string, string | null>) => {
    const base = configurationSnapshot(h.project, kind);
    return serializeConfigurationStage({ version: 1, base, next: { kind, binding: base.binding, files } });
  };
  let stages = 0;
  /** A new stage directory with what the entry answers now: every base is the project's current file. */
  const stage = (choices: DeployStageOptions = {}) => {
    const directory = join(h.root, `stage-${stages++}`), port = choices.port ?? 1011;
    const pick = <T>(value: T | null | undefined, fallback: T | null) => value === undefined ? fallback : value;
    const app = pick(choices.app, first ? APP : null), models = pick(choices.models, first ? MODELS : null);
    const files: Record<string, string | null> = {
      [DEPLOY_CHOICES_FILE]: JSON.stringify({ format: 1, target: choices.target ?? h.built, port, workspace: choices.workspace ?? "", cleanup: choices.cleanup ?? "skip" } satisfies DeployChoices),
      [RUNTIME_VALUES_FILE]: serializeRuntimeValues({ format: 1, base: runtimeDigest(current("data/config/runtime.json")), values: { BOT_PORT: String(port), ...choices.runtime } }),
      "data-plan.json": pick(choices.plan, first ? null : "{}\n"), "directory-scope-plan.json": pick(choices.directory, first ? DIRECTORY : null),
      [stageName("app")]: app === null ? null : staged("app", { app }),
      [stageName("models")]: models === null ? null : staged("models", { models: models.models, settings: models.settings, catalog: null }),
      ...platform, ...choices.platform };
    mkdirSync(directory, { mode: 0o700 });
    for (const [name, text] of Object.entries(files)) if (text !== null) writeFileSync(join(directory, name), text, { mode: 0o600 });
    return directory;
  };
  type Overrides = Parameters<typeof h.lifecycle>[1];
  const input = (value: Omit<DeployInput, "operation">): DeployInput => ({ operation: "deploy", ...value });
  return { ...h, first, facts, platform, stage,
    deploy: (directory: string, command: "deploy" | "repair" = "deploy", overrides: Overrides = {}) => h.lifecycle(input({ stage: directory, command }), overrides),
    resume: (overrides: Overrides = {}) => h.lifecycle(input({ command: "resume" }), overrides),
    rollback: (overrides: Overrides = {}) => h.lifecycle(input({ command: "rollback", rollback: true }), overrides),
    restore: (space: string) => h.lifecycle(input({ command: "revision-cleanup", restore: space })),
    preflight: () => preflightDockerDeploy(input({ command: "deploy" }), { project: h.project, source, native: h.native }) };
}
