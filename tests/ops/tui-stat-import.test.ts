// TUI 导入旧版统计：目录浏览选文件、只读预览、确认后交给 stat-import；已导入或已导入另一份时不运行命令。
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTheme } from "../../scripts/ops/tui/render/theme.ts";
import type { AppApi, ConfirmSpec, SelectSpec } from "../../scripts/ops/tui/view.ts";
import { directoryChoices, pickFile } from "../../scripts/ops/tui/views/file-picker.ts";
import { StatsView } from "../../scripts/ops/tui/views/stats.ts";
import { importLegacyStats } from "../../scripts/ops/stats-import.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("tui-stat-import-");
afterAll(() => fixture.cleanup());
const sqlite = (name: string) => /\.(sqlite3?|db)$/i.test(name);
const key = (name: string) => ({ name, raw: name, ctrl: false, shift: false });

/** A minimal schema-2 ledger of the webhook release with one ask and one model row, in WAL mode as that release kept it. */
function legacyLedger(path: string, asks = 1): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE stats_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO stats_schema VALUES (1, 2);
    CREATE TABLE sources (id TEXT PRIMARY KEY, group_segment TEXT NOT NULL, user_segment TEXT NOT NULL);
    CREATE TABLE activity (source TEXT NOT NULL, day TEXT NOT NULL, asks INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);
    CREATE TABLE usage_totals (source TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL);
    INSERT INTO sources VALUES ('s1', 'g', 'u');
    INSERT INTO activity VALUES ('s1', '2026-09-01', ${asks}, 100, 200);
    INSERT INTO usage_totals VALUES ('s1', '2026-09-01', 'p', 'm', 10, 5, 0, 0);`);
  db.close();
}

function fakeApp(root: string, choices: (string | null)[], answers: (string | null)[] = []) {
  const calls = { menus: [] as SelectSpec[], confirms: [] as ConfirmSpec[], commands: [] as string[][], toasts: [] as string[], prompts: [] as string[] };
  const app: AppApi = {
    theme: createTheme("truecolor"), deployment: { platform: "linux", runtime: "docker", port: 1011, dataRoot: root, workspaceRoot: "" },
    toast(_status, text) { calls.toasts.push(text); }, redraw() {}, go() {},
    async ask(label) { calls.prompts.push(label); return answers.shift() ?? null; },
    async choose(spec) { calls.menus.push(spec); return choices.shift() ?? null; },
    async confirm(spec) { calls.confirms.push(spec); return !spec.blocked; },
    async run(_title, args) { calls.commands.push(args); return 0; },
    async runInteractive() { throw new Error("测试不得执行真实运维命令"); },
    async openFile() {},
  };
  return { app, calls };
}

test("目录列表子目录在前、只列可选文件，隐藏点开头的条目；链接按目标列出", async () => {
  const dir = join(fixture.root, "listing");
  await mkdir(join(dir, "zeta"), { recursive: true });
  await mkdir(join(dir, "alpha"));
  await mkdir(join(dir, ".hidden"));
  await writeFile(join(dir, "stats.sqlite"), "x");
  await writeFile(join(dir, "notes.txt"), "x");
  await writeFile(join(dir, ".old.sqlite"), "x");
  if (process.platform !== "win32") symlinkSync(join(dir, "alpha"), join(dir, "linked"));
  const choices = directoryChoices(dir, sqlite);
  expect(choices.map(choice => choice.label)).toEqual(["alpha/", ...(process.platform === "win32" ? [] : ["linked/"]), "zeta/", "stats.sqlite"]);
  expect(choices.at(-1)).toMatchObject({ value: "f:" + join(dir, "stats.sqlite") });
  expect(choices.at(-1)!.description).toContain("修改于");
});

test("逐级进入目录选中文件，返回上一级时预选来处，也可以直接输入路径；Esc 取消", async () => {
  const top = join(fixture.root, "browse"), deep = join(top, "old", "data", "groups");
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "stats.sqlite"), "x");
  const spec = { title: "选", start: top, accept: sqlite };
  let fake = fakeApp(fixture.root, ["d:" + join(top, "old"), "@up", "d:" + join(top, "old"), "d:" + join(top, "old", "data"), "d:" + deep, "f:" + join(deep, "stats.sqlite")]);
  expect(await pickFile(fake.app, spec)).toBe(join(deep, "stats.sqlite"));
  expect(fake.calls.menus[0]!.description).toContain(top);
  expect(fake.calls.menus[0]!.choices.map(choice => choice.value)).toEqual(["@up", "@path", "d:" + join(top, "old")]);
  expect(fake.calls.menus[2]!.initial).toBe("d:" + join(top, "old"));
  // Typed paths: a directory opens it, a missing path stays put, a file is the answer.
  fake = fakeApp(fixture.root, ["@path", "@path", "@path"], [join(fixture.root, "absent"), "old/data", "groups/stats.sqlite"]);
  expect(await pickFile(fake.app, spec)).toBe(join(deep, "stats.sqlite"));
  expect(fake.calls.toasts).toEqual([`找不到：${join(fixture.root, "absent")}`]);
  fake = fakeApp(fixture.root, [null]);
  expect(await pickFile(fake.app, spec)).toBeNull();
});

test("统计页按 i 预览所选旧账本，确认后交给 stat-import；已导入的直接提示，导入过另一份时只说明原因", async () => {
  const root = join(fixture.root, "data"), old = join(fixture.root, "old");
  await mkdir(old, { recursive: true });
  const ledger = join(old, "stats.sqlite"), other = join(old, "other.sqlite");
  legacyLedger(ledger);
  legacyLedger(other, 2);
  const view = new StatsView(join(fixture.root, "reports"));
  expect(view.actions().find(action => action.value === "i")).toMatchObject({ label: "导入旧版统计" });

  let fake = fakeApp(root, ["f:" + ledger]);
  await view.onKey(key("i"), fake.app);
  expect(fake.calls.confirms).toHaveLength(1);
  expect(fake.calls.confirms[0]!.subject).toBe(ledger);
  expect(fake.calls.confirms[0]!.steps[0]).toContain("1 次提问（1 个成员日）");
  expect(fake.calls.commands).toEqual([["stat-import", ledger]]);

  importLegacyStats(ledger, root);
  fake = fakeApp(root, ["f:" + ledger]);
  await view.onKey(key("i"), fake.app);
  // The browser opens where the last file was chosen.
  expect(fake.calls.menus[0]!.description).toStartWith(old);
  expect(fake.calls.confirms).toEqual([]);
  expect(fake.calls.commands).toEqual([]);
  expect(fake.calls.toasts).toEqual(["这份旧统计已经导入过，不会重复计入"]);

  fake = fakeApp(root, ["f:" + other]);
  await view.onKey(key("i"), fake.app);
  expect(fake.calls.confirms[0]).toMatchObject({ blocked: true });
  expect(fake.calls.commands).toEqual([]);

  // Not a schema-2 ledger: refused before any confirmation; Esc in the browser cancels.
  await writeFile(join(old, "broken.db"), "not sqlite");
  fake = fakeApp(root, ["f:" + join(old, "broken.db")]);
  await view.onKey(key("i"), fake.app);
  expect(fake.calls.confirms).toEqual([]);
  expect(fake.calls.toasts[0]).toStartWith("不能导入：");
  fake = fakeApp(root, [null]);
  await view.onKey(key("i"), fake.app);
  expect(fake.calls.toasts).toEqual(["已取消"]);
});
