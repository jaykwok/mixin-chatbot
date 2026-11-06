// Single Docker effects of a deployment (DockerDeployment): publishing a tag, reclaiming this deployment's old images on the
// separate task daemon, and removing its own snapshot and archive after it completed. When the lifecycle runs them (cleanup only after a completed forward deployment, never after a
// rollback) is covered by core-docker-deploy.test.ts; this file checks what each one may change. Only the Docker process
// boundary is replaced.
import { expect, test } from "bun:test";
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DockerPlatform } from "../../ops/core/docker-host.ts";
import { candidateProjectId, DockerDeployment } from "../../ops/core/docker-deployment.ts";
import type { NativeRunner } from "../../ops/core/native-process.ts";
import { tempFixture } from "../helpers/temp.ts";

const MAIN = "unix:///run/main/docker.sock", TASK = "unix:///run/user/1002/docker.sock", TASK_UID = 1002;
const ids = Object.fromEntries(Object.entries({ current: "a", old: "b", cancelled: "c", rolledBack: "d",
  running: "e", stopped: "f", tagged: "1", digest: "2", foreign: "3", unlabelled: "4" })
  .map(([name, digit]) => [name, `sha256:${digit.repeat(64)}`])) as Record<string, string>;
type Failure = "" | "current" | "list" | "inspect" | "ps" | "rm";

async function fixture() {
  const f = await tempFixture("task-images-");
  await mkdir(join(f.root, "data"), { recursive: true });
  const project = candidateProjectId(f.root), images = new Map<string, string>();
  for (const [name, id] of Object.entries(ids)) {
    const owner = name === "foreign" ? "000000000000" : name === "unlabelled" ? "" : project;
    images.set(id, `${id}|${owner}|${name === "tagged" ? 1 : 0}|${name === "digest" ? 1 : 0}`);
  }
  const calls: string[] = [], removed: string[] = [], tags = new Map<string, string>();
  let failure: Failure = "", mainId = "main-daemon-01", taskId = "task-daemon-01", tagNoop = false;
  const run: NativeRunner = async (command, output) => {
    const [flag, endpoint, ...args] = command.args;
    expect(flag).toBe("--host");
    if (endpoint === MAIN) {
      const verb = args.slice(0, 2).join(" ");
      if (verb === "info --format") return { code: 0, stdout: JSON.stringify({ ID: mainId, SecurityOptions: [] }) };
      if (verb === "image tag") { if (!tagNoop) tags.set(args[3]!, args[2]!); return { code: 0, stdout: "" }; }
      if (verb === "image inspect") {
        const id = tags.get(args[2]!) ?? (images.has(args[2]!) ? args[2]! : undefined);
        if (!id) { output?.(`Error response from daemon: No such image: ${args[2]}\n`, "stderr"); return { code: 1, stdout: "" }; }
        return { code: 0, stdout: JSON.stringify([{ Id: id, Os: "linux", Architecture: "amd64", Config: { Labels: {}, Env: [] } }]) };
      }
      throw new Error("unexpected Docker command " + args.join(" "));
    }
    expect(endpoint).toBe(TASK);
    calls.push(args.join(" "));
    const verb = args.slice(0, 2).join(" "), last = args.at(-1)!;
    if (verb === "info --format") return { code: 0, stdout: JSON.stringify({ ID: taskId, SecurityOptions: ["name=rootless"] }) };
    if (verb === "image inspect") {
      if (failure === "current" && last === ids.current || failure === "inspect" && last === ids.old) return { code: 1, stdout: "" };
      const row = images.get(last);
      if (!row) return { code: 1, stdout: "" };
      return { code: 0, stdout: (args[3]!.includes("RepoTags") ? row : row.split("|").slice(0, 2).join("|")) + "\n" };
    }
    if (verb === "image ls") return failure === "list" ? { code: 1, stdout: "" } : { code: 0, stdout: [...images.keys()].join("\n") + "\n" };
    if (verb === "ps --all") {
      if (failure === "ps") return { code: 1, stdout: "" };
      return { code: 0, stdout: last === "ancestor=" + ids.running ? "running-container\n" : last === "ancestor=" + ids.stopped ? "stopped-container\n" : "" };
    }
    if (verb === "image rm") {
      expect(args).toEqual(["image", "rm", "--no-prune", last]);
      if (failure === "rm") return { code: 1, stdout: "" };
      images.delete(last); removed.push(last); return { code: 0, stdout: "" };
    }
    throw new Error("unexpected Docker command " + args.join(" "));
  };
  const connect = () => DockerPlatform.connect(f.root, run, { uid: 0, env: { DOCKER_HOST: MAIN }, data: () => join(f.root, "data"),
    socket: path => ({ uid: path === TASK.slice(7) ? TASK_UID : 0, socket: true, link: false }) });
  return {
    root: f.root, images, calls, removed, tags,
    set failure(value: Failure) { failure = value; },
    set mainId(value: string) { mainId = value; },
    set taskId(value: string) { taskId = value; },
    set tagNoop(value: boolean) { tagNoop = value; },
    effects: async () => new DockerDeployment(f.root, await connect(), () => {}),
    async clean() {
      calls.length = 0;
      return (await this.effects()).cleanupTaskImages({ endpoint: TASK, daemon: "task-daemon-01" }, TASK_UID, ids.current!);
    },
    cleanup: () => f.cleanup(),
  };
}

test("发布标签后核对它确实指向候选镜像；没有指向时报告失败", async () => {
  const f = await fixture();
  try {
    const effects = await f.effects();
    await effects.tag(ids.current!, "mixin-bot");
    expect(f.tags.get("mixin-bot")).toBe(ids.current);
    f.tagNoop = true;
    await expect(effects.tag(ids.old!, "mixin-bot")).rejects.toThrow(`mixin-bot 没有指向 ${ids.old}（当前 ${ids.current}）`);
    await expect(effects.tag(ids.old!, "mixin-bot:other")).rejects.toThrow("（当前 不存在）");
  } finally { await f.cleanup(); }
});

test("任务 daemon 只回收本项目、无标签无摘要、无容器引用的旧镜像；不强删、不 prune", async () => {
  const f = await fixture();
  try {
    await f.clean();
    expect(f.removed).toEqual([ids.old, ids.cancelled, ids.rolledBack]);
    expect(f.calls.join("\n")).not.toContain("--force");
    expect(f.calls.filter(call => /^(image|system|builder) prune/.test(call))).toEqual([]);
    // Current, running and stopped workers, tagged or pinned images and other projects' images all remain.
    for (const name of ["current", "running", "stopped", "tagged", "digest", "foreign", "unlabelled"]) expect(f.images.has(ids[name]!), name).toBe(true);
  } finally { await f.cleanup(); }
});

test("任务 daemon 与服务共用时不回收；daemon 身份变化时拒绝，不列出镜像", async () => {
  const f = await fixture();
  try {
    f.mainId = "task-daemon-01";
    await f.clean();
    expect(f.calls.some(call => call.startsWith("image ls"))).toBe(false);
    f.mainId = "main-daemon-01"; f.taskId = "changed-daemon";
    await expect(f.clean()).rejects.toThrow("任务 daemon 与部署记录不同");
    expect(f.calls.some(call => call.startsWith("image ls"))).toBe(false);
    expect(f.removed).toEqual([]);
  } finally { await f.cleanup(); }
});

test("清单不确定时停止回收，删除失败时报告未完成；之后成功的部署重试", async () => {
  const f = await fixture();
  try {
    for (const failure of ["current", "list", "inspect", "ps", "rm"] as const) {
      f.failure = failure;
      await expect(f.clean(), failure).rejects.toThrow();
      expect(f.removed, failure).toEqual([]);
    }
    f.failure = "";
    await f.clean();
    expect(f.removed).toEqual([ids.old, ids.cancelled, ids.rolledBack]);
  } finally { await f.cleanup(); }
});

// What a completed deployment must leave in backup/: everything it does not own by name.
const unrelatedBackups = {
  "backup/snapshots/deploy-failed/recovery": "failed transaction",
  "backup/snapshots/tunnel-0123456789abcdef0123456789abcdef/tunnel.xml": "connector snapshot",
  "backup/rm/deploy-previous/old-config": "earlier transaction",
  "backup/rm/deploy-currentX/old-config": "name sharing the prefix",
  "backup/rm/loose-file": "loose archive",
  "backup/rm/.hidden-file": "hidden archive",
  "backup/reports/usage.html": "report",
};

test("完成后只删除本事务的快照和归档；路径中有链接时什么也不删；剩下空目录时保留 backup/ 本身（服务的挂载点）", async () => {
  const f = await fixture();
  try {
    const write = async (path: string, text: string) => { await mkdir(dirname(join(f.root, path)), { recursive: true }); await writeFile(join(f.root, path), text); };
    for (const [path, text] of Object.entries(unrelatedBackups)) await write(path, text);
    await write("backup/snapshots/deploy-current/transaction", "own"); await write("backup/rm/deploy-current/old-config", "own");
    const effects = await f.effects();
    effects.removeCompleted("deploy-current");
    expect(existsSync(join(f.root, "backup/snapshots/deploy-current"))).toBe(false);
    expect(existsSync(join(f.root, "backup/rm/deploy-current"))).toBe(false);
    for (const [path, text] of Object.entries(unrelatedBackups)) expect(await readFile(join(f.root, path), "utf8"), path).toBe(text);

    // A link in place of the archive is refused before anything is removed, and its target is never entered.
    await write("outside/keep", "outside"); await write("backup/snapshots/deploy-linked/transaction", "own");
    symlinkSync(join(f.root, "outside"), join(f.root, "backup/rm/deploy-linked"), "junction");
    expect(() => effects.removeCompleted("deploy-linked")).toThrow("快照路径含有链接");
    expect(await readFile(join(f.root, "backup/snapshots/deploy-linked/transaction"), "utf8")).toBe("own");
    expect(await readFile(join(f.root, "outside/keep"), "utf8")).toBe("outside");
    // A dangling link is no missing path either: refused, and the snapshot stays.
    await write("backup/snapshots/deploy-dangling/transaction", "own");
    symlinkSync(join(f.root, "never-created"), join(f.root, "backup/rm/deploy-dangling"), "junction");
    expect(() => effects.removeCompleted("deploy-dangling")).toThrow("失效的链接");
    expect(await readFile(join(f.root, "backup/snapshots/deploy-dangling/transaction"), "utf8")).toBe("own");
  } finally { await f.cleanup(); }
  const alone = await fixture();
  try {
    await mkdir(join(alone.root, "backup/snapshots/deploy-only"), { recursive: true }); await mkdir(join(alone.root, "backup/rm/deploy-only"), { recursive: true });
    (await alone.effects()).removeCompleted("deploy-only");
    expect(await readdir(join(alone.root, "backup"))).toEqual([]);
  } finally { await alone.cleanup(); }
});
