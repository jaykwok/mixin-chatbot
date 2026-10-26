// Release gate of the current data format (scripts/runtime/data-current.ts): new install versus upgrade, the deployment
// record written only at commit, and refusal (leaving everything as it is) of data without a valid record.
import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { applySqliteMigrations, SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import { inspectDataVersion } from "../../src/core/data-version.ts";
import { openGroupDatabase, openGroupStorage } from "../../src/durable/sqlite.ts";
import { APP_VERSION, DATA_VERSION } from "../../src/core/version.ts";
import { CURRENT_APPLICATION, writeCurrentConfig } from "../helpers/current-config.ts";
import { tempFixture } from "../helpers/temp.ts";

const runner = fileURLToPath(new URL("../../scripts/runtime/data-current.ts", import.meta.url));
const verifier = fileURLToPath(new URL("../../src/server/verify.ts", import.meta.url));
const deployment = "deploy-current123";
const BUILD = "abc1234def5678";
const APPLICATION = CURRENT_APPLICATION;
async function run(project: string, action: string, id = deployment, build = BUILD, extra: string[] = []) {
  const child = Bun.spawn([process.execPath, runner, action, "--project", project, "--deployment", id, "--plan", join(project, "plan.json"), ...extra], {
    cwd: project, env: { ...process.env, BOT_OPERATION_LOG: "", APP_BUILD: build },
    stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, text: out + err };
}
const marker = (project: string) => join(project, "data/state/data-version.json");
const release = (project: string) => join(project, "data/state/release-data.json");
const record = async (project: string) => JSON.parse(await readFile(marker(project), "utf8"));
async function sequence(project: string, actions: string[], id = deployment, build = BUILD) {
  for (const action of actions) { const result = await run(project, action, id, build); expect(result.code, `${action}: ${result.text}`).toBe(0); }
}

test("an empty directory is a fresh install; the record names the deployed program and build, written only at commit", async () => {
  const f = await tempFixture("current-fresh-");
  try {
    await writeCurrentConfig(f.root);
    // Operator materials in the default workspace are not data: a fresh install keeps them.
    await mkdir(join(f.root, "data/workspace"), { recursive: true }); await writeFile(join(f.root, "data/workspace/reference.txt"), "keep");
    const preview = await run(f.root, "preview");
    expect(preview.code, preview.text).toBe(0);
    expect(preview.text).toContain(`程序 v${APP_VERSION}（构建 abc1234），数据格式 ${DATA_VERSION}：全新安装`);
    // An upgrade needs a deployment record: the empty directory is refused and nothing is written.
    const upgrade = await run(f.root, "preview", deployment, BUILD, ["--upgrade"]);
    expect(upgrade.code).toBe(1); expect(upgrade.text).toContain("目录没有部署记录，不能升级");
    await sequence(f.root, ["apply", "apply", "validate"]);
    expect(existsSync(marker(f.root))).toBe(false);
    expect(inspectDataVersion(f.root).current).toBe(false);
    await sequence(f.root, ["commit", "commit", "committed"]);
    expect(await record(f.root)).toEqual({ dataVersion: DATA_VERSION, appVersion: APP_VERSION, build: BUILD, transaction: deployment, application: APPLICATION });
    expect(inspectDataVersion(f.root)).toEqual({ current: true, detail: `数据格式 ${DATA_VERSION}` });
    expect((await run(f.root, "rollback")).code).toBe(42);
    expect((await run(f.root, "committed", "deploy-other")).code).toBe(1);
    expect(await readFile(join(f.root, "data/workspace/reference.txt"), "utf8")).toBe("keep");
  } finally { await f.cleanup(); }
  // Eleven sequential runner processes: 8 s alone, 28 s seen with a parallel group (Windows process start costs).
}, 60000);

test("a valid record is an upgrade: the old record stays until commit, and rollback of an interrupted commit restores it", async () => {
  const f = await tempFixture("current-upgrade-");
  try {
    await writeCurrentConfig(f.root);
    await mkdir(join(f.root, "data/state"), { recursive: true });
    const previous = { dataVersion: DATA_VERSION, appVersion: "1.0.0", build: "0011223344", transaction: "deploy-previous", application: APPLICATION };
    await writeFile(marker(f.root), JSON.stringify(previous));
    await mkdir(join(f.root, "data/conversations/direct"), { recursive: true });
    const check = await run(f.root, "check");
    expect(check.code, check.text).toBe(0);
    expect(check.text).toContain("已部署 v1.0.0（构建 0011223），数据格式一致");
    const upgrade = await run(f.root, "preview", deployment, BUILD, ["--upgrade"]);
    expect(upgrade.code, upgrade.text).toBe(0);
    await sequence(f.root, ["preview", "apply"]);
    expect(await record(f.root)).toEqual(previous);
    expect(JSON.parse(await readFile(release(f.root), "utf8"))).toMatchObject({ deployment, phase: "prepared", previous });
    // A commit interrupted after writing the record but before marking the release committed.
    await writeFile(marker(f.root), JSON.stringify({ ...previous, appVersion: APP_VERSION, build: BUILD, transaction: deployment, application: APPLICATION }));
    await sequence(f.root, ["rollback"]);
    expect(await record(f.root)).toEqual(previous);
    expect(existsSync(release(f.root))).toBe(false);
    // The same upgrade again, committed this time.
    await sequence(f.root, ["preview", "apply", "commit"]);
    expect(await record(f.root)).toEqual({ dataVersion: DATA_VERSION, appVersion: APP_VERSION, build: BUILD, transaction: deployment, application: APPLICATION });
  } finally { await f.cleanup(); }
});

test("rolling back an interrupted fresh install removes its record", async () => {
  const f = await tempFixture("current-fresh-rollback-");
  try {
    await writeCurrentConfig(f.root);
    await sequence(f.root, ["preview", "apply"]);
    await writeFile(marker(f.root), JSON.stringify({ dataVersion: DATA_VERSION, appVersion: APP_VERSION, build: BUILD, transaction: deployment, application: APPLICATION }));
    await sequence(f.root, ["rollback"]);
    for (const path of [marker(f.root), release(f.root)]) expect(existsSync(path)).toBe(false);
  } finally { await f.cleanup(); }
});

for (const [name, store] of [["legacy group root", "data/groups/g/users"], ["conversations", "data/conversations/groups/g"],
  ["tmp", "data/tmp/direct/u"], ["state database", "data/state/agent.sqlite"]] as const)
  test(`data without a record (${name}) refuses install and upgrade and is left as it is`, async () => {
    const f = await tempFixture("current-unrecorded-");
    try {
      await writeCurrentConfig(f.root);
      if (store.endsWith(".sqlite")) { await mkdir(join(f.root, "data/state"), { recursive: true }); await writeFile(join(f.root, store), "old"); }
      else await mkdir(join(f.root, store), { recursive: true });
      for (const action of ["check", "preview", "apply"]) {
        const result = await run(f.root, action);
        expect(result.code).toBe(1);
        expect(result.text).toContain("目录中已有数据但没有有效的版本标记");
        expect(result.text).toContain("请在新目录全新部署");
      }
      for (const path of [marker(f.root), release(f.root)]) expect(existsSync(path)).toBe(false);
      expect(existsSync(join(f.root, store))).toBe(true);
    } finally { await f.cleanup(); }
  });

for (const [name, content, message] of [
  ["legacy marker without a program version", JSON.stringify({ dataVersion: 5, transaction: "old" }), "版本标记没有程序版本"],
  ["record missing fields", JSON.stringify({ dataVersion: DATA_VERSION, appVersion: "1.0.0", build: "x" }), "版本标记损坏"],
  ["unreadable record", "{not json", "无法读取版本状态"],
  ["unsupported data format", JSON.stringify({ dataVersion: DATA_VERSION + 1, appVersion: "9.0.0", build: "", transaction: "deploy-future" }), "不受当前程序支持"],
] as const)
  test(`${name}: an error; nothing is initialised and the record is kept`, async () => {
    const f = await tempFixture("current-bad-record-");
    try {
      await writeCurrentConfig(f.root);
      await mkdir(join(f.root, "data/state"), { recursive: true });
      await writeFile(marker(f.root), content);
      for (const action of ["check", "preview", "apply", "commit"]) {
        const result = await run(f.root, action);
        expect(result.code).toBe(1);
        expect(result.text).toContain(action === "commit" ? "没有本次发布的数据准备记录" : message);
      }
      expect(await readFile(marker(f.root), "utf8")).toBe(content);
      expect(existsSync(release(f.root))).toBe(false);
      expect(inspectDataVersion(f.root).current).toBe(false);
    } finally { await f.cleanup(); }
  });

test("competing releases, a changed record after preview and a missing app-bot configuration are refused", async () => {
  const f = await tempFixture("current-refusals-");
  try {
    await writeCurrentConfig(f.root);
    await sequence(f.root, ["preview", "apply"]);
    expect((await run(f.root, "apply", "deploy-other")).text).toContain("另一次发布尚未完成");
    await sequence(f.root, ["rollback"]);
    expect((await run(f.root, "preview")).code).toBe(0);
    await writeFile(marker(f.root), JSON.stringify({ dataVersion: DATA_VERSION, appVersion: "1.0.0", build: "", transaction: "deploy-elsewhere", application: APPLICATION }));
    expect((await run(f.root, "apply")).text).toContain("版本标记已变化");
    expect(existsSync(release(f.root))).toBe(false);
    await rm(join(f.root, "data/config/app-bot.json"));
    expect((await run(f.root, "preview")).text).toContain("缺少应用机器人配置");
  } finally { await f.cleanup(); }
});

for (const finish of ["commit", "rollback"] as const)
  test(`${finish} works through a linked project directory`, async () => {
    const f = await tempFixture("current-junction-");
    try {
      const real = join(f.root, "real-project"), alias = join(f.root, "alias");
      await writeCurrentConfig(real);
      await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
      await sequence(alias, ["preview", "apply", finish]);
      expect(existsSync(marker(real))).toBe(finish === "commit");
      expect(existsSync(release(real))).toBe(finish === "commit");
    } finally { await f.cleanup(); }
  }, 60000);

// F1: the data belongs to the application recorded at the last commit. Another AppID or platform environment is refused
// by every gate before the stop and again at commit, leaving the record and the prepared release as they are.
const appBot = (project: string, config: Record<string, string>) =>
  writeFile(join(project, "data/config/app-bot.json"), JSON.stringify({ environment: "production", appId: "test-app", appSecret: "test-only-secret", ...config }));
for (const [name, change] of [["another AppID", { appId: "another-app" }], ["another platform environment", { environment: "staging" }]] as const)
  test(`${name} is refused before the stop and at commit; the record stays`, async () => {
    const f = await tempFixture("current-binding-");
    try {
      await writeCurrentConfig(f.root);
      await sequence(f.root, ["preview", "apply", "commit"], "deploy-first");
      const recorded = await readFile(marker(f.root), "utf8");
      expect(JSON.parse(recorded).application).toBe(APPLICATION);
      await appBot(f.root, change);
      for (const action of ["check", "preview", "validate"]) {
        const result = await run(f.root, action);
        expect(result.code, action).toBe(1);
        expect(result.text).toContain("数据目录登记的应用或平台环境与 data/config/app-bot.json 不一致");
      }
      // Changed after preview (a wizard run after the stop): commit refuses, the release stays prepared for rollback.
      await appBot(f.root, {});
      await sequence(f.root, ["preview", "apply"]);
      await appBot(f.root, change);
      const commit = await run(f.root, "commit");
      expect(commit.code).toBe(1);
      expect(commit.text).toContain("数据目录登记的应用或平台环境");
      expect(await readFile(marker(f.root), "utf8")).toBe(recorded);
      expect(JSON.parse(await readFile(release(f.root), "utf8"))).toMatchObject({ deployment, phase: "prepared" });
      await sequence(f.root, ["rollback"]);
      expect(await readFile(marker(f.root), "utf8")).toBe(recorded);
    } finally { await f.cleanup(); }
  }, 60000);

test("a rotated AppSecret is the same application: the upgrade commits and keeps the binding", async () => {
  const f = await tempFixture("current-binding-secret-");
  try {
    await writeCurrentConfig(f.root);
    await sequence(f.root, ["preview", "apply", "commit"], "deploy-first");
    await appBot(f.root, { appSecret: "rotated-test-secret" });
    await sequence(f.root, ["check", "preview", "apply", "commit"]);
    expect(await record(f.root)).toMatchObject({ transaction: deployment, application: APPLICATION });
  } finally { await f.cleanup(); }
}, 60000);

test("a record without the application binding is refused like any incomplete record", async () => {
  const f = await tempFixture("current-binding-missing-");
  try {
    await writeCurrentConfig(f.root);
    await mkdir(join(f.root, "data/state"), { recursive: true });
    const content = JSON.stringify({ dataVersion: DATA_VERSION, appVersion: "1.0.0", build: "", transaction: "deploy-unreleased" });
    await writeFile(marker(f.root), content);
    for (const action of ["check", "preview", "apply", "validate"]) {
      const result = await run(f.root, action);
      expect(result.code, action).toBe(1);
      expect(result.text).toContain("版本标记没有应用绑定");
    }
    expect(await readFile(marker(f.root), "utf8")).toBe(content);
    expect(existsSync(release(f.root))).toBe(false);
  } finally { await f.cleanup(); }
});

// F2: the final workspace is checked by the gates before the stop (preview/check get it with --workspace, since the
// service's runtime.json is written only later) and again at commit, by the same rule as the service start.
test("a workspace inside managed state fails preview, validate and commit; nothing is committed", async () => {
  const f = await tempFixture("current-layout-state-");
  try {
    await writeCurrentConfig(f.root);
    const state = join(f.root, "data/state");
    await mkdir(state, { recursive: true });
    const runtime = join(f.root, "data/config/runtime.json");
    await writeFile(runtime, JSON.stringify({ WORKSPACE_ROOT: state }));
    for (const action of ["preview", "validate"]) {
      const result = await run(f.root, action);
      expect(result.code, action).toBe(1);
      expect(result.text).toContain("位于受管目录");
    }
    // Valid at preview, changed before the commit: the commit refuses and the release stays prepared.
    await writeFile(runtime, "{}");
    await sequence(f.root, ["preview", "apply"]);
    await writeFile(runtime, JSON.stringify({ WORKSPACE_ROOT: state }));
    const commit = await run(f.root, "commit");
    expect(commit.code).toBe(1);
    expect(commit.text).toContain("位于受管目录");
    expect(existsSync(marker(f.root))).toBe(false);
    expect(JSON.parse(await readFile(release(f.root), "utf8"))).toMatchObject({ deployment, phase: "prepared" });
  } finally { await f.cleanup(); }
}, 60000);

test("--workspace names the final workspace for check, preview and commit, whatever runtime.json still says", async () => {
  const f = await tempFixture("current-layout-final-");
  try {
    await writeCurrentConfig(f.root);
    const outside = join(f.root, "materials"), file = join(f.root, "file.txt");
    await mkdir(outside); await writeFile(file, "");
    await mkdir(join(f.root, "data/runtime/home"), { recursive: true });
    for (const [workspace, message] of [
      [join(f.root, "data/runtime/home"), "位于受管目录"], [join(f.root, "data/config"), "位于受管目录"], [join(f.root, "backup"), "位于受管目录"],
      [f.root, "包含数据目录"], [join(f.root, "data"), "包含数据目录"], [join(f.root, "missing"), "WORKSPACE_ROOT 不存在"], [file, "资料目录不是目录"],
    ] as const) {
      if (workspace.endsWith("backup")) await mkdir(workspace, { recursive: true });
      for (const action of ["check", "preview"]) {
        const result = await run(f.root, action, deployment, BUILD, ["--workspace", workspace]);
        expect(result.code, `${action} ${workspace}`).toBe(1);
        expect(result.text).toContain(message);
      }
    }
    expect(existsSync(join(f.root, "missing"))).toBe(false);
    for (const action of ["check", "preview", "apply", "commit"]) {
      const result = await run(f.root, action, deployment, BUILD, ["--workspace", outside]);
      expect(result.code, `${action}: ${result.text}`).toBe(0);
    }
    expect(existsSync(join(f.root, "data/workspace"))).toBe(false);
  } finally { await f.cleanup(); }
}, 60000);

test("data/config linked into the external workspace fails check and preview before the stop; nothing is committed", async () => {
  const f = await tempFixture("current-layout-reverse-");
  try {
    const outside = join(f.root, "materials"), hidden = join(outside, "private-config");
    await mkdir(hidden, { recursive: true });
    await mkdir(join(f.root, "data"), { recursive: true });
    await symlink(hidden, join(f.root, "data/config"), "junction");
    await writeCurrentConfig(f.root);
    for (const action of ["check", "preview"]) {
      const result = await run(f.root, action, deployment, BUILD, ["--workspace", outside]);
      expect(result.code, action).toBe(1);
      expect(result.text).toContain("实际位于资料目录");
    }
    expect(existsSync(marker(f.root))).toBe(false);
    expect(existsSync(release(f.root))).toBe(false);
  } finally { await f.cleanup(); }
}, 60000);

test("a conversation database of another Durable schema fails validate, the verification instance and commit; the release rolls back", async () => {
  const f = await tempFixture("current-space-schema-");
  try {
    await writeCurrentConfig(f.root);
    await mkdir(join(f.root, "data/state"), { recursive: true });
    const previous = { dataVersion: DATA_VERSION, appVersion: "1.0.0", build: "0011223344", transaction: "deploy-previous", application: APPLICATION };
    await writeFile(marker(f.root), JSON.stringify(previous));
    // A current group database passes: the upgrade validates and commits.
    const group = join(f.root, "data/conversations/groups/g1");
    await mkdir(group, { recursive: true });
    await createSession(await openGroupStorage(join(group, "durable.sqlite"))).close(context);
    await sequence(f.root, ["preview", "apply", "validate", "commit", "committed"]);
    const committed = await record(f.root);
    expect(committed).toMatchObject({ transaction: deployment });
    // The next upgrade finds a schema-1 direct database (say, restored from an unreleased test directory).
    const direct = join(f.root, "data/conversations/direct");
    await mkdir(direct, { recursive: true });
    const old = await openGroupDatabase(join(direct, "durable.sqlite"));
    try { await applySqliteMigrations(old, SQLITE_MIGRATIONS.slice(0, 1)); } finally { await old.close(); }
    const digest = () => createHash("sha256").update(readFileSync(join(direct, "durable.sqlite"))).digest("hex");
    const before = digest(), next = "deploy-next456";
    await sequence(f.root, ["preview", "apply"], next);
    for (const action of ["validate", "commit"]) {
      const result = await run(f.root, action, next);
      expect(result.code, `${action}: ${result.text}`).toBe(1);
      expect(result.text).toContain("Durable schema 1");
    }
    // The verification instance runs the same check, so it never reports ready on such data and the upgrader rolls back.
    const verification = Bun.spawn([process.execPath, verifier], {
      cwd: f.root, env: { ...process.env, BOT_OPERATION_LOG: "" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, out, err] = await Promise.all([verification.exited, new Response(verification.stdout).text(), new Response(verification.stderr).text()]);
    expect(code, out + err).not.toBe(0);
    expect(out + err).toContain("Durable schema 1");
    expect(existsSync(join(f.root, "data/state/instance.json"))).toBe(false);
    expect(await record(f.root)).toEqual(committed);
    expect(JSON.parse(await readFile(release(f.root), "utf8"))).toMatchObject({ deployment: next, phase: "prepared" });
    expect(digest()).toBe(before);
    await sequence(f.root, ["rollback"], next);
    expect(existsSync(release(f.root))).toBe(false);
    expect(await record(f.root)).toEqual(committed);
    expect(digest()).toBe(before);
  } finally { await f.cleanup(); }
}, 60000);

test("the verification instance reports ready, refuses another token and stops on its own, removing instance.json", async () => {
  const f = await tempFixture("current-verify-");
  let verification: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await writeCurrentConfig(f.root);
    await sequence(f.root, ["preview", "apply"]);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port; await probe.stop(true);
    verification = Bun.spawn([process.execPath, verifier], {
      cwd: f.root, env: { ...process.env, BOT_OPERATION_LOG: "", BOT_PORT: String(port) }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const instance = join(f.root, "data/state/instance.json"), deadline = Date.now() + 20_000;
    let token: string | undefined;
    while (token === undefined) {
      if (Date.now() > deadline || verification.exitCode !== null) throw new Error("the verification instance did not start");
      // The file may be seen while it is still being written.
      try { token = (JSON.parse(await readFile(instance, "utf8")) as { token?: string }).token; } catch { await Bun.sleep(20); }
    }
    const base = `http://127.0.0.1:${port}`;
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ status: "ready", verificationOnly: true });
    const refused = await fetch(`${base}/_admin/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${token.slice(1)}x` } });
    expect(refused.status).toBe(503);
    expect(verification.exitCode).toBeNull();
    const stopped = await fetch(`${base}/_admin/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(await stopped.json()).toEqual({ status: "stopping" });
    expect(await verification.exited).toBe(0);
    expect(existsSync(instance)).toBe(false);
  } finally { verification?.kill(); await verification?.exited; await f.cleanup(); }
}, 60000);
