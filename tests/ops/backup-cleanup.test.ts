import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { appendFile, chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { apply, scan, type Entry } from "../../scripts/ops/backup-cleanup.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = join(import.meta.dir, "../..");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posixPath = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
// Directory junctions need no privilege on Windows; elsewhere an ordinary directory symlink.
const link = (target: string, path: string) => symlink(target, path, process.platform === "win32" ? "junction" : "dir");
async function put(root: string, path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
// Only the 1 MiB zero filler of the fixture below is uniform; this one differs in its last byte.
// The fixture directory name a helper archive was made from: <name>-<UUIDv4>.
const base = (name: string) => name.slice(0, -37);
const almostFiller = () => { const data = Buffer.alloc(1024 * 1024); data[data.length - 1] = 1; return data; };

/** Every path below root (except skip) with size and modification time, for proving that a scan changes nothing. */
async function listing(root: string, skip: string): Promise<string[]> {
  const lines: string[] = [];
  async function children(path: string) {
    for (const child of await readdir(path)) if (join(path, child) !== skip) await visit(join(path, child));
  }
  async function visit(path: string) {
    const stat = await lstat(path);
    lines.push(`${relative(root, path)} ${stat.isSymbolicLink() ? "link" : stat.size} ${stat.mtimeMs}`);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await children(path);
  }
  // backup/ itself gains the cleanup directory; everything else must stay as it was.
  await children(root);
  return lines.sort();
}

/** A project whose backup/ holds each kind of entry the scan must tell apart. */
async function backupProject(root: string) {
  const rm = (name: string) => `backup/rm/${name}`;
  const names = {
    self: `deploy-flow-Q9wErT-${randomUUID()}`, testRoot: `log-retention-Zx81Kp-${randomUUID()}`, filler: `relay-sign-M3nB7v-${randomUUID()}`,
    domain: `relay-ttl-Pq5Rs2-${randomUUID()}`, file: `draft.json-${randomUUID()}`, changed: `change-me-Gh56Jk-${randomUUID()}`,
    replaced: `replace-me-Rt67Yu-${randomUUID()}`, swapped: `swap-me-Vb89Nm-${randomUUID()}`, suspected: `mixin-chatbot-relay-Kk3Jj9-${randomUUID()}`,
    weak: `pattern-Hh8Gg7-${randomUUID()}`, innerLink: `inner-link-Cd34Ef-${randomUUID()}`, topLink: `escape-Ab12Cd-${randomUUID()}`,
    session: `1758000000000-${randomUUID()}-session.jsonl`, shell: "1758000000-12345-678-models.json",
    windows: `${randomUUID().replace(/-/g, "")}-relay.json`, transaction: "deploy-Ab12Cd34", unknown: "random-notes",
  };
  const migration = `migration-${randomUUID()}`;
  await put(root, `${rm(names.self)}/state.txt`, `fixture root ${base(names.self)}/data`);
  await put(root, `${rm(names.testRoot)}/config.json`, JSON.stringify({ root: "D:\\Projects\\mixin-chatbot\\tmp\\tests-Ab12Cd\\fixtures\\other" }));
  await put(root, `${rm(names.filler)}/outside/secret.bin`, Buffer.alloc(1024 * 1024));
  await put(root, `${rm(names.domain)}/relay.json`, JSON.stringify({ url: "https://files.example.test/relay" }));
  await put(root, rm(names.file), JSON.stringify({ domain: "bot.example.test" }));
  for (const name of [names.changed, names.replaced, names.swapped]) await put(root, `${rm(name)}/state.txt`, `created under ${base(name)}`);
  // Whole seconds, so that a replacement (and its directory) can carry exactly the same modification times.
  await utimes(join(root, rm(names.replaced), "state.txt"), 1758000000, 1758000000);
  await utimes(join(root, rm(names.replaced)), 1758000000, 1758000000);
  await put(root, `${rm(names.suspected)}/note.txt`, "hello https://example.com");
  await put(root, `${rm(names.suspected)}/blob.bin`, almostFiller());
  await put(root, `${rm(names.weak)}/code.ts`, "if (re.test(value)) return;\nimport './commands.test.ts';\nimport 'node:test';\n");
  await put(root, "outside/keep.txt", "outside");
  await put(root, `${rm(names.innerLink)}/state.txt`, `created under ${base(names.innerLink)}`);
  await link(join(root, "outside"), join(root, rm(names.innerLink), "out"));
  await link(join(root, "outside"), join(root, rm(names.topLink)));
  await put(root, rm(names.session), '{"role":"user","content":"请把上周的周报再发我一次"}\n');
  await put(root, rm(names.shell), '{"providers":{}}');
  await put(root, rm(names.windows), '{"enabled":true}');
  await put(root, `${rm(names.transaction)}/1758000000-1-2-models.json`, '{"providers":{}}');
  await put(root, `${rm(names.unknown)}/todo.txt`, "manual notes");
  await put(root, "backup/snapshots/deploy-Zz99Yy88/transaction", "format=1\n");
  await put(root, `backup/snapshots/${migration}/manifest.json`, "{}");
  await put(root, "backup/reports/usage.html", "<html></html>");
  await put(root, "data/state/migration.json", JSON.stringify({ backup: `backup/snapshots/${migration}`, deployment: "deploy-Qq11Ww22" }));
  return { names, migration };
}

async function editActions(root: string, report: string, actions: Record<string, "delete" | "keep">): Promise<void> {
  const path = join(root, "backup/cleanup", report, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  for (const entry of manifest.entries as Entry[]) if (entry.path in actions) entry.action = actions[entry.path]!;
  await writeFile(path, JSON.stringify(manifest));
}

test("backup scan classifies archives by name and content evidence without changing anything", async () => {
  const fixture = await tempFixture("backup-scan-");
  try {
    const root = fixture.root, { names, migration } = await backupProject(root);
    const before = await listing(join(root, "backup"), join(root, "backup/cleanup"));
    const scanned = scan(root);
    expect(await listing(join(root, "backup"), join(root, "backup/cleanup"))).toEqual(before);
    const entry = (path: string) => scanned.entries.find(item => item.path === path)!;
    const category = (name: string) => entry(`backup/rm/${name}`)?.category;
    for (const name of [names.self, names.testRoot, names.filler, names.domain, names.file, names.changed, names.replaced, names.swapped]) {
      expect(category(name), name).toBe("confirmed-test");
      expect(entry(`backup/rm/${name}`).action).toBe("delete");
    }
    const basis = (name: string) => entry(`backup/rm/${name}`).basis.join(" ");
    expect(basis(names.self)).toContain("自己的随机名称"); expect(basis(names.testRoot)).toContain("测试临时目录");
    expect(basis(names.filler)).toContain("单字节填充文件"); expect(basis(names.domain)).toContain("files.example.test");
    // A name alone is only a clue: no content evidence, a non-uniform large file, and code mentioning .test stay suspected.
    for (const name of [names.suspected, names.weak]) expect(category(name), name).toBe("suspected-test");
    for (const name of [names.innerLink, names.topLink, names.unknown]) expect(category(name), name).toBe("unknown");
    expect(basis(names.innerLink)).toContain("内部含链接"); expect(basis(names.topLink)).toContain("链接");
    for (const name of [names.session, names.shell, names.windows, names.transaction]) expect(category(name), name).toBe("business");
    expect(entry("backup/snapshots/deploy-Zz99Yy88").category).toBe("business");
    expect(entry(`backup/snapshots/${migration}`).category).toBe("business");
    expect(entry(`backup/snapshots/${migration}`).basis.join(" ")).toContain("迁移日志");
    // Only confirmed test data is suggested for deletion; reports and the manifest itself are never scanned.
    expect(scanned.entries.filter(item => item.action === "delete").every(item => item.category === "confirmed-test")).toBe(true);
    expect(scanned.entries.some(item => !/^backup\/(rm|snapshots)\//.test(item.path))).toBe(false);
    expect(scanned.skipped).toEqual(["reports"]);
    const tsv = await readFile(join(root, "backup/cleanup", scanned.report!, "manifest.tsv"), "utf8");
    expect(tsv).toContain("可确认测试数据"); expect(tsv).toContain("疑似测试数据"); expect(tsv).toContain("业务归档"); expect(tsv).toContain("无法判断");
  } finally { await fixture.cleanup(); }
}, 30000);

test("backup cleanup deletes only entries the manifest selects, after rechecking each one", async () => {
  const fixture = await tempFixture("backup-apply-");
  try {
    const root = fixture.root, { names, migration } = await backupProject(root);
    const { report } = scan(root);
    const rm = (name: string) => `backup/rm/${name}`;
    // The reviewer selects one business snapshot, and tries a protected, a suspected and an unknown entry too.
    await editActions(root, report!, {
      "backup/snapshots/deploy-Zz99Yy88": "delete", [`backup/snapshots/${migration}`]: "delete",
      [rm(names.suspected)]: "delete", [rm(names.unknown)]: "delete",
    });
    // Changes after the scan: appended content, a link swapped in for an entry, and a replacement file with the same
    // name, content, size and times as the scanned one (its directory's time restored too): only the inode tells.
    await appendFile(join(root, rm(names.changed), "state.txt"), " and changed");
    const replaced = join(root, rm(names.replaced), "state.txt");
    await writeFile(join(root, "replacement"), await readFile(replaced)); await utimes(join(root, "replacement"), 1758000000, 1758000000);
    await rename(join(root, "replacement"), replaced);
    await utimes(join(root, rm(names.replaced)), 1758000000, 1758000000);
    await rename(join(root, rm(names.swapped)), join(root, "swapped-away"));
    await link(join(root, "swapped-away"), join(root, rm(names.swapped)));

    const preview = apply(root, report!);
    const outcome = (results: typeof preview.results, path: string) => results.find(result => result.path === path)!;
    for (const name of [names.self, names.testRoot, names.filler, names.domain, names.file]) expect(outcome(preview.results, rm(name)).outcome, name).toBe("would-delete");
    expect(outcome(preview.results, "backup/snapshots/deploy-Zz99Yy88").outcome).toBe("would-delete");
    expect(existsSync(join(root, rm(names.self)))).toBe(true);
    expect(preview.resultFile).toBeNull();
    expect(() => apply(root, report!, "0".repeat(16))).toThrow("确认码与当前清单不符");
    // Editing the manifest after the preview invalidates its confirmation code (the suspected entry still stays).
    await editActions(root, report!, { [rm(names.weak)]: "delete" });
    expect(() => apply(root, report!, preview.code)).toThrow("确认码与当前清单不符");
    const current = apply(root, report!);

    const done = apply(root, report!, current.code);
    const deleted = [names.self, names.testRoot, names.filler, names.domain, names.file].map(rm).concat("backup/snapshots/deploy-Zz99Yy88");
    for (const path of deleted) {
      expect(outcome(done.results, path).outcome, path).toBe("deleted");
      expect(existsSync(join(root, path)), path).toBe(false);
    }
    for (const name of [names.changed, names.replaced]) expect(outcome(done.results, rm(name)).outcome, name).toBe("changed");
    expect(outcome(done.results, rm(names.swapped)).outcome).toBe("refused");
    expect(outcome(done.results, `backup/snapshots/${migration}`)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("迁移日志") });
    for (const name of [names.suspected, names.unknown]) expect(outcome(done.results, rm(name)).reason, name).toContain("从不删除");
    // Everything not deleted is still there, links included, and nothing behind a link was entered.
    for (const name of Object.values(names)) if (!deleted.includes(rm(name))) expect((await lstat(join(root, rm(name)))).isSymbolicLink() || existsSync(join(root, rm(name))), name).toBe(true);
    expect(await readFile(join(root, "outside/keep.txt"), "utf8")).toBe("outside");
    expect(await readFile(join(root, "swapped-away/state.txt"), "utf8")).toContain("created under");
    expect(existsSync(join(root, `backup/snapshots/${migration}/manifest.json`))).toBe(true);
    expect(existsSync(join(root, "backup/reports/usage.html"))).toBe(true);
    // The result is kept beside the manifest, one record per manifest entry.
    const saved = JSON.parse(await readFile(done.resultFile + ".json", "utf8"));
    expect(saved.results).toHaveLength(done.results.length);
    expect(await readFile(done.resultFile + ".tsv", "utf8")).toContain("已删除");
  } finally { await fixture.cleanup(); }
}, 30000);

test("backup cleanup rejects a tampered manifest, a pending transaction and a redirected recycle area", async () => {
  const fixture = await tempFixture("backup-refuse-");
  try {
    const root = fixture.root, { names } = await backupProject(root);
    const { report } = scan(root);
    const manifestPath = join(root, "backup/cleanup", report!, "manifest.json");
    const original = await readFile(manifestPath, "utf8");
    const target = `backup/rm/${names.self}`;
    const tamper = async (change: (entries: Entry[]) => void) => {
      const manifest = JSON.parse(original); change(manifest.entries); await writeFile(manifestPath, JSON.stringify(manifest));
    };
    await tamper(entries => { entries.find(entry => entry.path === target)!.path = "backup/rm/../../data"; });
    expect(() => apply(root, report!)).toThrow("路径越界");
    await tamper(entries => { entries.find(entry => entry.path === `backup/rm/${names.suspected}`)!.category = "confirmed-test"; });
    expect(() => apply(root, report!)).toThrow("除 action 以外的内容被改动过");
    await tamper(entries => { entries.push({ ...entries.find(entry => entry.path === target)! }); });
    expect(() => apply(root, report!)).toThrow("路径重复");
    expect(() => apply(root, "../escape")).toThrow("报告名无效");
    await writeFile(manifestPath, original);

    const legacy = JSON.parse(original); legacy.format = 1;
    await writeFile(manifestPath, JSON.stringify(legacy));
    expect(() => apply(root, report!)).toThrow("旧版清单没有文件内容摘要");
    expect(existsSync(join(root, target))).toBe(true);
    await writeFile(manifestPath, original);

    await put(root, "data/state/upgrade-transaction", "deploy-" + "a".repeat(32));
    expect(() => apply(root, report!)).toThrow("有未完成的部署或升级");
    await rename(join(root, "data/state/upgrade-transaction"), join(root, "upgrade-transaction.saved"));

    // The recycle area replaced by a link after the scan: every selected entry is refused, nothing behind it removed.
    await rename(join(root, "backup/rm"), join(root, "backup/rm-real"));
    await link(join(root, "backup/rm-real"), join(root, "backup/rm"));
    const code = apply(root, report!).code;
    const done = apply(root, report!, code);
    expect(done.results.filter(result => result.outcome === "deleted")).toEqual([]);
    expect(done.results.find(result => result.path === target)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("链接") });
    expect(existsSync(join(root, "backup/rm-real", names.self, "state.txt"))).toBe(true);
  } finally { await fixture.cleanup(); }
}, 30000);

test("backup cleanup keeps changed bytes even when file identity, length and modification time match the scan", async () => {
  const fixture = await tempFixture("backup-content-change-");
  try {
    const paths = [`backup/rm/small-Ab12Cd-${randomUUID()}`, `backup/rm/large-Ef34Gh-${randomUUID()}`, "backup/snapshots/deploy-Ab12Cd34"];
    const files = paths.map(path => join(fixture.root, path, "state.bin"));
    const originals = [Buffer.from("https://files.example.test OLD"), Buffer.alloc(2 * 1024 * 1024 + 17), Buffer.from("business archive OLD")];
    for (let i = 0; i < paths.length; i++) {
      await put(fixture.root, `${paths[i]}/state.bin`, originals[i]!);
      await utimes(files[i]!, 1758000000, 1758000000);
    }
    const { report } = scan(fixture.root);
    await editActions(fixture.root, report!, { [paths[2]!]: "delete" });
    const approved = apply(fixture.root, report!);
    expect(approved.results.every(result => result.outcome === "would-delete")).toBe(true);
    for (const file of files) {
      const before = await lstat(file, { bigint: true });
      const changed = await readFile(file); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      await writeFile(file, changed);
      await utimes(file, 1758000000, 1758000000);
      const after = await lstat(file, { bigint: true });
      expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs]);
    }
    // The confirmation code is still valid, but no longer authorizes these changed files.
    for (const result of [apply(fixture.root, report!), apply(fixture.root, report!, approved.code)]) {
      expect(result.results.map(item => item.outcome)).toEqual(["changed", "changed", "changed"]);
    }
    for (const file of files) expect(existsSync(file)).toBe(true);
  } finally { await fixture.cleanup(); }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("backup cleanup refuses whole archives when any file becomes unreadable after the scan", async () => {
  const fixture = await tempFixture("backup-permission-change-");
  const paths = [`backup/rm/permission-Ab12Cd-${randomUUID()}`, "backup/snapshots/deploy-Ab12Cd34"];
  const secrets = paths.map(path => join(fixture.root, path, "z-secret.txt"));
  try {
    for (const path of paths) {
      await put(fixture.root, `${path}/a-evidence.txt`, "https://files.example.test/data");
      await put(fixture.root, `${path}/z-secret.txt`, "must survive");
    }
    const { report } = scan(fixture.root);
    await editActions(fixture.root, report!, { [paths[1]!]: "delete" });
    const approved = apply(fixture.root, report!);
    expect(approved.results.every(result => result.outcome === "would-delete")).toBe(true);
    for (const file of secrets) {
      await chmod(file, 0o000);
      expect(() => fs.readFileSync(file)).toThrow();
    }
    for (const result of [apply(fixture.root, report!), apply(fixture.root, report!, approved.code)]) {
      for (const entry of result.results) expect(entry).toMatchObject({ outcome: "refused", reason: expect.stringContaining("无法读取") });
    }
    for (const path of paths) expect(await readFile(join(fixture.root, path, "a-evidence.txt"), "utf8")).toContain("example.test");
    for (const file of secrets) expect(existsSync(file)).toBe(true);
  } finally {
    for (const file of secrets) await chmod(file, 0o600).catch(() => {});
    await fixture.cleanup();
  }
});

for (const retry of [false, true]) test.skipIf(process.platform !== "win32")(`backup cleanup handles Windows read-only files (${retry ? "EPERM retry" : "native unlink"}) and preserves unselected files`, async () => {
  const fixture = await tempFixture("backup-readonly-");
  const selected = `backup/rm/readonly-Ab12Cd-${randomUUID()}`, kept = `backup/rm/retained-Ef34Gh-${randomUUID()}`;
  const file = join(fixture.root, selected), retained = join(fixture.root, kept);
  try {
    for (const path of [selected, kept]) { await put(fixture.root, path, "https://files.example.test/data"); await chmod(join(fixture.root, path), 0o444); }
    const { report } = scan(fixture.root);
    await editActions(fixture.root, report!, { [kept]: "keep" });
    const preview = apply(fixture.root, report!);
    expect((await lstat(file)).mode & 0o222).toBe(0);
    // Bun can remove a read-only file itself. Also exercise the access-denied result on runtimes/filesystems
    // that leave clearing the attribute to the caller, then perform the real unlink on the retry.
    const unlink = fs.unlinkSync;
    let denied = false;
    const removals = retry ? spyOn(fs, "unlinkSync").mockImplementation(path => {
      if (path === file && !denied) { denied = true; throw Object.assign(new Error("read-only file"), { code: "EPERM" }); }
      return unlink(path);
    }) : undefined;
    const changes = spyOn(fs, "chmodSync");
    try {
      const done = apply(fixture.root, report!, preview.code);
      expect(done.results.find(entry => entry.path === selected)?.outcome).toBe("deleted");
      if (retry) {
        expect(denied).toBe(true);
        expect(changes).toHaveBeenCalledWith(file, 0o666);
        expect(changes).toHaveBeenCalledTimes(1);
        expect(removals).toHaveBeenCalledTimes(2);
      }
    } finally { changes.mockRestore(); removals?.mockRestore(); }
    expect(existsSync(file)).toBe(false);
    expect(await readFile(retained, "utf8")).toContain("example.test");
    expect((await lstat(retained)).mode & 0o222).toBe(0);
  } finally {
    for (const path of [file, retained]) await chmod(path, 0o666).catch(() => {});
    await fixture.cleanup();
  }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("backup scan keeps entries it cannot read in full as undeterminable", async () => {
  const fixture = await tempFixture("backup-unreadable-");
  const locked = join(fixture.root, "backup/rm", `locked-Ab12Cd-${randomUUID()}`, "inner");
  // Evidence comes first in traversal order; the file after it still has to be readable.
  const evident = `evident-Ef56Gh-${randomUUID()}`, secret = join(fixture.root, "backup/rm", evident, "b-secret.bin");
  try {
    await put(fixture.root, relative(fixture.root, join(locked, "state.txt")), "x");
    await put(fixture.root, `backup/rm/${evident}/a-state.txt`, `created under ${base(evident)}`);
    await put(fixture.root, relative(fixture.root, secret), "secret");
    await chmod(locked, 0o000); await chmod(secret, 0o000);
    const entries = scan(fixture.root).entries;
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry, entry.path).toMatchObject({ category: "unknown", action: "keep" });
      expect(entry.basis.join(" ")).toContain("无法读取");
    }
  } finally {
    await chmod(locked, 0o700).catch(() => {}); await chmod(secret, 0o600).catch(() => {});
    await fixture.cleanup();
  }
});

test.skipIf(!bash || !existsSync(bash))("ops.sh backup-scan and backup-clean hand the report and confirmation code to the tool", async () => {
  const fixture = await tempFixture("backup-ops-linux-");
  const root = fixture.root, log = join(root, "docker.log");
  try {
    await cp(join(project, "scripts/lib"), join(root, "scripts/lib"), { recursive: true });
    await mkdir(join(root, "scripts/ops"), { recursive: true }); await copyFile(join(project, "scripts/ops/ops.sh"), join(root, "scripts/ops/ops.sh"));
    // An exported function, not a PATH stub (the Windows CI runner skipped PATH stubs): the bot container is running.
    const docker = `() { echo "$*" >> '${posixPath(log)}'; [ "$1" != ps ] || echo mixin-chatbot\n}`;
    const ops = async (...args: string[]) => {
      const child = Bun.spawn([bash!, posixPath(join(root, "scripts/ops/ops.sh")), ...args], { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, MSYS_NO_PATHCONV: "1", "BASH_FUNC_docker%%": docker, BOT_PORT: "", BOT_DOMAIN: "" } });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, out + err).toBe(0);
    };
    // Each ops.sh start costs seconds under Git Bash; the preview differs from the confirmed call only by the passed-through code.
    await ops("backup-scan");
    await ops("backup-clean", "20260928T000000Z-abcdef", "--confirm", "0123456789abcdef");
    const calls = (await readFile(log, "utf8")).split("\n").filter(line => line.startsWith("exec "));
    expect(calls).toEqual([
      "exec mixin-chatbot bun run scripts/ops/backup-cleanup.ts scan",
      "exec mixin-chatbot bun run scripts/ops/backup-cleanup.ts apply 20260928T000000Z-abcdef --confirm 0123456789abcdef",
    ]);
  } finally { await fixture.cleanup(); }
}, 30000);

test("backup-cleanup command scans by default, previews with a confirmation code and deletes only when confirmed", async () => {
  const fixture = await tempFixture("backup-command-");
  try {
    const root = fixture.root, { names } = await backupProject(root);
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, join(project, "scripts/ops/backup-cleanup.ts"), ...args], { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, text: out + err };
    };
    const scanned = await run();
    expect(scanned.code, scanned.text).toBe(0);
    expect(scanned.text).toContain("没有删除任何内容");
    const report = /backup\/cleanup\/(\S+)\/manifest\.json/.exec(scanned.text)![1]!;
    const preview = await run("apply", report);
    expect(preview.code, preview.text).toBe(0);
    const code = /确认码：([0-9a-f]{16})/.exec(preview.text)![1]!;
    expect(existsSync(join(root, "backup/rm", names.self))).toBe(true);
    const done = await run("apply", report, "--confirm", code);
    expect(done.code, done.text).toBe(0);
    expect(existsSync(join(root, "backup/rm", names.self))).toBe(false);
    expect(existsSync(join(root, "backup/rm", names.session))).toBe(true);
    expect((await run("apply")).code).toBe(1);
  } finally { await fixture.cleanup(); }
}, 30000);
