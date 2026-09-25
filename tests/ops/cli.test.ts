import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArgs, groupOptions, groupSelection } from "../../scripts/lib/cli.ts";
import { opsCommand } from "../../scripts/ops/tui/platform.ts";
import { tempFixture } from "../helpers/temp.ts";

test("standard CLI parsing rejects ambiguous selections and retains literal option values", () => {
  const options = { ...groupOptions, group: { type: "string" } } as const;
  expect(() => cliArgs(["--group-id", "--group-id"], options)).toThrow("重复");
  expect(() => groupSelection({ "group-id": true })).toThrow("指定群");
  expect(() => groupSelection({ "group-id": true, "storage-segment": true }, "g")).toThrow("同时");
  expect(cliArgs(["--group=--group-id"], options).values.group).toBe("--group-id");
  expect(() => cliArgs(["--group"], options)).toThrow();
  const command = opsCommand("windows", ["tmp-ls", "--group", "-Repair", "--group-id"]);
  expect(JSON.parse(Buffer.from(command.args[6]!, "base64").toString())).toMatchObject({ Group: "-Repair", GroupId: true });
  const linux = opsCommand("linux", ["tmp-ls", "--group", "-Repair", "--group-id"]);
  expect(cliArgs(linux.args.slice(2), options).values.group).toBe("-Repair");
  const stat = opsCommand("linux", ["stat", "-Repair", "--group-id"]);
  expect(cliArgs(stat.args.slice(2), groupOptions).positionals).toEqual(["-Repair"]);
});

test("tmp and stat return one for duplicate or targetless selectors without unhandled errors", async () => {
  const f = await tempFixture("cli-errors-");
  try {
    for (const [file, args] of [["tmp-admin.ts", ["list"]], ["stats-admin.ts", []]] as const) {
      for (const flags of [["--group-id"], ["--group-id", "--group-id"], ["--storage-segment", "--group-id"]]) {
        const child = Bun.spawn([process.execPath, join(fileURLToPath(new URL("../../scripts/ops/", import.meta.url)), file), ...args, ...flags],
          { cwd: f.root, env: { ...process.env, GROUP_DATA_ROOT: join(f.root, "groups") }, stdout: "pipe", stderr: "pipe", windowsHide: true });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(code).toBe(1); expect(stderr).not.toContain("at main");
        expect(stderr).toMatch(/重复|指定群|同时/);
      }
    }
  } finally { await f.cleanup(); }
}, 15000);
