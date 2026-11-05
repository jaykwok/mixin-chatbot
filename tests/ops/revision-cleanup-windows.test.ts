// The Windows deployment entry's helpers (scripts/lib/deployment.ps1) with the real revision-cleanup.ts and maintenance.ts on
// synthetic projects. They read the tools' results through the versioned JSON protocol, with the descriptions on stderr
// reaching the host decoded as UTF-8: the choice made before the stop is one string and touches no data; any value but
// apply or skip is refused before the stop; a restore pending refuses the preview and leaves only the restore. The shared
// core records the choice and runs the cleanup after the stop (core-windows-deploy.test.ts, core-revision.test.ts).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assessMaintenanceAction, readMaintenanceState, type MaintenanceIntent } from "../../src/core/maintenance-state.ts";
import { readJournal } from "../../src/durable/revision-cleanup/journal.ts";
import { applyCleanup } from "../../src/durable/revision-cleanup/run.ts";
import { chainState, writeLongChains, type ChainState } from "../helpers/revision-chains.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const quotePS = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const windows = process.platform === "win32";

type Fixture = { root: string; database: string; before: ChainState; cleanup: () => Promise<void>; base: string };

async function synthetic(name: string): Promise<Fixture> {
  const fixture = await tempFixture("revision-cleanup-windows-" + name + "-");
  const root = join(fixture.root, "project"), database = join(root, "data/conversations/direct/durable.sqlite");
  await writeLongChains(database, 70);
  await mkdir(join(root, "data/state"), { recursive: true });
  return { root, database, before: read(database), cleanup: () => fixture.cleanup(), base: fixture.root };
}

function read(database: string): ChainState {
  const db = new Database(database, { readonly: true });
  try { return chainState(db); } finally { db.close(); }
}

/** Runs `lines` in Windows PowerShell with the deployment helpers loaded; `$out` is written back as JSON. */
async function powershell(fixture: Fixture, lines: string[], env: Record<string, string> = {}) {
  const runner = join(fixture.base, `run-${Math.random().toString(36).slice(2)}.ps1`), result = join(fixture.base, "result.json");
  await writeFile(runner, "\ufeff" + [
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    `. ${quotePS(join(project, "scripts/lib/common.ps1"))}`,
    "$Root=$env:FIXTURE_PROJECT; $Bun=$env:FIXTURE_BUN; $Script=$env:FIXTURE_SCRIPT",
    "$out=@{}",
    ...lines,
    "[IO.File]::WriteAllText($env:FIXTURE_RESULT, (ConvertTo-Json -Compress -Depth 5 -InputObject $out))",
  ].join("\r\n"));
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner], {
    cwd: fixture.base, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, BOT_REVISION_CLEANUP: "", BOT_OPERATION_LOG: "", FIXTURE_PROJECT: fixture.root, FIXTURE_BUN: process.execPath,
      FIXTURE_SCRIPT: join(project, "scripts/runtime/revision-cleanup.ts"), FIXTURE_RESULT: result, ...env },
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stdout + stderr).toBe(0);
  return { out: JSON.parse(await readFile(result, "utf8")) as Record<string, any>, stdout };
}

/** `$out.<key>` is the message the command threw, or "returned". */
const caught = (key: string, command: string) => `try { ${command}; $out.${key}='returned' } catch { $out.${key}=$_.Exception.Message }`;

const chosen = [
  "$choice=Select-RevisionCleanup $Bun $Script $Root",
  "$out.type=$(if($null -eq $choice){''}else{$choice.GetType().FullName}); $out.count=@($choice).Count; $out.choice=@($choice)",
];

test.skipIf(!windows)("Select-RevisionCleanup 在真实的预览与空间检查之后只返回选择，不碰数据；说明按 UTF-8 显示", async () => {
  for (const choice of ["apply", "skip"]) {
    const fixture = await synthetic(choice);
    try {
      const { out, stdout } = await powershell(fixture, chosen, { BOT_REVISION_CLEANUP: choice });
      // Before the first fix: ["所需空间（含保留 1.00 GB）：…", "apply"].
      expect(out).toEqual({ type: "System.String", count: 1, choice: [choice] });
      expect(stdout).toContain("待整理文档 10 份");
      if (choice === "apply") {
        // Once: the preview leaves the space to the check made for the choice.
        expect(stdout.split("所需空间").length - 1).toBe(1);
        expect(stdout).toMatch(/停机后整理旧修订链，约 \d+ 分钟；先备份要修改的会话库/);
      } else expect(stdout).toContain("跳过修订整理");
      expect(readJournal(join(fixture.root, "data"))).toBeUndefined();
      expect(read(fixture.database)).toEqual(fixture.before);
    } finally { await fixture.cleanup(); }
  }
}, 120_000);

test.skipIf(!windows)("apply、skip 以外的选择（例如 no-backup）停机前拒绝，不碰数据", async () => {
  const fixture = await synthetic("no-backup");
  try {
    const { out } = await powershell(fixture, [caught("select", "$null = Select-RevisionCleanup $Bun $Script $Root")], { BOT_REVISION_CLEANUP: "no-backup" });
    expect(out.select).toContain("BOT_REVISION_CLEANUP 只能是 apply（默认）或 skip；服务尚未停止");
    expect(readJournal(join(fixture.root, "data"))).toBeUndefined();
    expect(read(fixture.database)).toEqual(fixture.before);
  } finally { await fixture.cleanup(); }
}, 120_000);

test.skipIf(!windows)("待从备份恢复：预览被拒绝（服务尚未停止），维护状态只允许恢复；恢复后允许启动", async () => {
  const fixture = await synthetic("restore");
  try {
    let calls = 0;
    await applyCleanup({ project: fixture.root, hooks: { value: value => ++calls === 2 ? { ...value, corrupted: true } : undefined } }).catch(() => undefined);
    expect(readJournal(join(fixture.root, "data"))!.restore).toMatchObject({ space: "direct", state: "required" });
    // The state the shared core assesses before it starts the bot (service host `assess`).
    const allows = (intent: MaintenanceIntent) => assessMaintenanceAction(readMaintenanceState(fixture.root), intent).allowed;
    expect({ service: allows("service"), restore: allows("restore") }).toEqual({ service: false, restore: true });
    const { out, stdout } = await powershell(fixture, [
      caught("select", "$null = Select-RevisionCleanup $Bun $Script $Root"),
      "$restored=Invoke-MaintenanceTool $Bun $Script 'restore' @('--space', 'direct', '--project', $Root)",
      "$out.restored=Test-MaintenanceSuccess $restored; $out.space=$restored.Result.space",
    ]);
    expect(out).toEqual({ select: expect.stringContaining("修订整理预览被拒绝（原因见上方）；服务尚未停止"), restored: true, space: "direct" });
    expect(allows("service")).toBe(true);
    // The reasons the tools gave reach the host, decoded.
    expect(stdout).toContain("这个库需要从备份恢复（revision-cleanup restore --space direct）");
    expect(stdout).toContain("direct 已从备份恢复");
    // The stopped run stays until revision-cleanup skip, or a deployment that chose to skip it, ends it. A console task
    // cannot set BOT_REVISION_CLEANUP: it is told to preview again and choose to skip.
    const fromConsole = await powershell(fixture, [caught("select", "$null = Select-RevisionCleanup $Bun $Script $Root")], { MIXIN_OPS_CONSOLE: "1" });
    expect(fromConsole.out.select).toContain("或重新预览并选择“跳过整理”；服务尚未停止");
    expect(readJournal(join(fixture.root, "data"))).toMatchObject({ state: "stopped", restore: { state: "done" } });
    expect(read(fixture.database)).toEqual(fixture.before);
  } finally { await fixture.cleanup(); }
}, 120_000);
