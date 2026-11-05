import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { cliArgs, groupOptions, groupSelection } from "../../scripts/lib/cli.ts";
import { opsCommand } from "../../scripts/ops/shared/platform.ts";
import { ADVANCED_RUNTIME_KEYS } from "../../src/core/runtime-schema.ts";
import { tempFixture } from "../helpers/temp.ts";

test("standard CLI parsing rejects ambiguous selections and retains literal option values", () => {
  const options = { ...groupOptions, group: { type: "string" } } as const;
  expect(() => cliArgs(["--group-id", "--group-id"], options)).toThrow("重复");
  expect(() => groupSelection({ "group-id": true })).toThrow("指定群");
  expect(() => groupSelection({ "group-id": true, "storage-segment": true }, "g")).toThrow("同时");
  expect(cliArgs(["--group=--group-id"], options).values.group).toBe("--group-id");
  expect(() => cliArgs(["--group"], options)).toThrow();
  const preview = ["tmp-preview", "--plan", "a-plan", "--group", "-Repair", "--storage-segment"];
  const command = opsCommand("windows", preview);
  expect(JSON.parse(Buffer.from(command.args[6]!, "base64").toString())).toMatchObject({ Group: "-Repair", StorageSegment: true });
  const linux = opsCommand("linux", preview);
  expect(cliArgs(linux.args.slice(2), { ...options, plan: { type: "string" } }).values.group).toBe("-Repair");
});

test("tmp and stat return one for duplicate or targetless selectors without unhandled errors", async () => {
  const f = await tempFixture("cli-errors-");
  try {
    for (const [file, args] of [["tmp-admin.ts", ["list"]], ["stats-admin.ts", []]] as const) {
      for (const flags of [["--group-id"], ["--group-id", "--group-id"], ["--storage-segment", "--group-id"]]) {
        const child = Bun.spawn([process.execPath, join(fileURLToPath(new URL("../../scripts/ops/", import.meta.url)), file), ...args, ...flags],
          { cwd: f.root, env: process.env, stdout: "pipe", stderr: "pipe", windowsHide: true });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(code).toBe(1); expect(stderr).not.toContain("at main");
        expect(stderr).toMatch(/重复|指定群|同时/);
      }
    }
  } finally { await f.cleanup(); }
}, 15000);

test("网页命令提示使用实际页面，显示上下文不启用写操作保护协议", async () => {
  const f = await tempFixture("console-hints-");
  try {
    const source = readFileSync(fileURLToPath(new URL("../../scripts/lib/common.sh", import.meta.url)), "utf8").replaceAll("\r\n", "\n");
    const from = source.indexOf("ops_command_hint() {"), until = source.indexOf("\n}\n", from);
    expect(from).toBeGreaterThan(-1); expect(until).toBeGreaterThan(from);
    const script = join(f.root, "hints.sh");
    writeFileSync(script, source.slice(from, until + 3) + '\nops_command_hint "$1"\n');
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    for (const platform of ["linux", "windows"] as const) {
      const command = opsCommand(platform, ["doctor", "--json"], f.root, f.root, "console");
      expect(command.env.MIXIN_OPS_UI).toBe("console"); expect(opsCommand(platform, ["doctor"], f.root).env.MIXIN_OPS_UI).toBe("cli");
      expect(command.env.MIXIN_OPS_CONSOLE).toBeUndefined(); expect(command.env.MIXIN_OPS_GUARD).toBeUndefined();
    }
    for (const [command, expected] of [["resume", "「维护 → 继续上次操作」"], ["logs", "「日志」"],
      ["doctor", "「体检 → 刷新」"], ["configure-app-bot", "「设置 → 应用机器人凭据」"], ["relay-configure", "「设置 → 外链配置」"],
      ["uninstall", "scripts/ops/ops.sh uninstall"]]) {
      const child = Bun.spawn([bash, script.replaceAll("\\", "/"), command!], { cwd: f.root, windowsHide: true,
        env: { ...process.env, MIXIN_OPS_UI: "console" }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0); expect(stdout).toBe(expected!);
    }
  } finally { await f.cleanup(); }
});

test("升级忽略的终端变量就是部署可从环境保存的运行参数（端口和共享资料目录另列）", () => {
  const source = readFileSync(fileURLToPath(new URL("../../scripts/lib/common.sh", import.meta.url)), "utf8").replaceAll("\r\n", "\n");
  const list = source.match(/^RUNTIME_ENV_KEYS=\(([^)]*)\)$/m)?.[1];
  expect(list?.trim().split(/\s+/)).toEqual([...ADVANCED_RUNTIME_KEYS]);
});
