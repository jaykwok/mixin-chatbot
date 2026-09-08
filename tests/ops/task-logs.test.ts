import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const powershell = Bun.which(process.platform === "win32" ? "powershell.exe" : "pwsh");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posixPath = (path: string) => path.replaceAll("\\", "/")
  .replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

type Platform = "powershell" | "bash";

async function fixture(platform: Platform) {
  const temporary = await tempFixture("task-logs-");
  const root = join(temporary.root, "生产 [测试] 项目");
  const logs = join(root, "logs");
  await mkdir(logs, { recursive: true });
  await mkdir(join(root, "scripts/ops"), { recursive: true });
  const filename = "task-logs." + (platform === "powershell" ? "ps1" : "sh");
  const script = join(root, "scripts/ops", filename);
  await copyFile(join(project, "scripts/ops", filename), script);
  return { ...temporary, root, logs, script, cwd: temporary.root };
}

async function execute(platform: Platform, script: string, args: string[], cwd: string) {
  const command = platform === "powershell"
    ? [powershell!, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]
    : [bash!, posixPath(script), ...args];
  const child = Bun.spawn(command, {
    cwd, env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}

async function readReport(root: string): Promise<Record<string, string>> {
  const parent = join(root, "backup/tmp");
  const dirs = await readdir(parent);
  expect(dirs).toHaveLength(1);
  const output = join(parent, dirs[0]!);
  return Object.fromEntries(await Promise.all(["task.log", "context.log", "summary.txt"].map(async name =>
    [name, (await readFile(join(output, name), "utf8")).replaceAll("\r\n", "\n")])));
}

const progress = (kind: string, stage: string, elapsed: number, idle: number, id = "555d838a") =>
  "2026-09-08 13:00:00 - INFO - " + kind + " - 任务: " + id +
  ", 群: 测试群, 用户: test-user, 阶段: " + stage + ", 耗时: " + elapsed + "秒, 最近进展距今: " + idle + "秒";

for (const platform of ["powershell", "bash"] as const) {
  const available = platform === "powershell" ? !!powershell : !!bash && existsSync(bash);
  describe.skipIf(!available)(platform + " task log extraction", () => {
    test("extracts the task across numeric rotations with deduplicated context and the correct model", async () => {
      const f = await fixture(platform);
      const contents = {
        "mixin-chatbot.log.10": "2026-09-08 12:59:00 - INFO - Pi ModelRuntime 就绪（provider=before-provider, model=test-model）\n",
        "mixin-chatbot.log.2": [
          "2026-09-08 12:59:59 - INFO - before task",
          progress("任务开始", "准备会话", 0, 0),
          progress("模型调用开始", "模型调用准备（含历史检查）", 1, 0),
        ].join("\n") + "\n",
        "mixin-chatbot.log.1": [
          "2026-09-08 13:00:01 - INFO - context across rotation",
          progress("任务进展", "接收模型输出", 2, 0, "555D838A"),
          progress("任务仍在运行", "接收模型输出", 60, 0),
          ...Array.from({ length: 9 }, (_, i) => "2026-09-08 13:02:00 - INFO - noise-" + i),
        ].join("\n") + "\n",
        "mixin-chatbot.log": [
          progress("任务仍在运行", "接收模型输出", 1140, 1020),
          progress("任务总时限到达", "接收模型输出", 1200, 1080),
          progress("任务进展", "等待取消清理", 1200, 0),
          "2026-09-08 13:20:01 - ERROR - 请求处理失败 - 错误: 任务总时限 1200 秒已到（阶段：接收模型输出；任务：555d838a）",
          "2026-09-08 13:21:00 - INFO - Pi ModelRuntime 就绪（provider=after-provider, model=other-model）",
          progress("任务开始", "准备会话", 0, 0, "555d838a0"),
          "2026-09-08 13:21:01 - INFO - mentioned 555d838a without a task field",
        ].join("\r\n"), // A final line without a newline must not crash extraction.
        "mixin-chatbot.log.old": progress("任务开始", "wrong file", 0, 0),
      };
      try {
        for (const [name, text] of Object.entries(contents)) await writeFile(join(f.logs, name), text);
        const result = await execute(platform, f.script, ["555D838A"], f.cwd);
        expect(result.code, result.output).toBe(0);
        expect(existsSync(join(f.root, "agents"))).toBe(false);
        const report = await readReport(f.root);
        const task = report["task.log"]!;
        const context = report["context.log"]!;
        const summary = report["summary.txt"]!;
        expect(task.trim().split("\n")).toHaveLength(8);
        expect(task.startsWith("mixin-chatbot.log.2:2:")).toBe(true);
        expect(task).toContain("任务：555d838a");
        expect(task).not.toContain("555d838a0");
        expect(task).not.toContain("mentioned");
        expect(task).not.toContain("wrong file");
        expect(context).toContain("context across rotation");
        expect(context).toContain("before task");
        expect(context).toContain("\n--\n");
        expect(context).not.toContain("noise-4");
        const contextLines = context.trim().split("\n").filter(line => line !== "--");
        expect(new Set(contextLines).size).toBe(contextLines.length);
        expect(summary).toContain("匹配行数: 8");
        expect(summary.indexOf("  mixin-chatbot.log.10")).toBeLessThan(summary.indexOf("  mixin-chatbot.log.2"));
        expect(summary).toContain("provider=before-provider");
        expect(summary).not.toContain("provider=after-provider");
        expect(summary).toContain("耗时: 1140秒, 最近进展距今: 1020秒");
        expect(summary).toContain("任务总时限到达");
        expect(summary).toContain("耗时: 1200秒, 最近进展距今: 1080秒");
        for (const [name, text] of Object.entries(contents)) expect(await readFile(join(f.logs, name), "utf8")).toBe(text);
      } finally { await f.cleanup(); }
    }, 30_000);

    test("accepts an alternate log directory and zero context; repeated runs preserve earlier output", async () => {
      const f = await fixture(platform);
      try {
        const alternate = join(f.root, "另一份 [日志]");
        await mkdir(alternate);
        await writeFile(join(alternate, "mixin-chatbot.log"), "unrelated before\n" +
          progress("任务开始", "准备会话", 0, 0) + "\nunrelated after\n");
        const options = platform === "powershell"
          ? ["-Context", "0", "-LogDir", alternate]
          : ["--context", "0", "--log-dir", posixPath(alternate)];
        const result = await execute(platform, f.script, ["555d838a", ...options], f.cwd);
        expect(result.code, result.output).toBe(0);
        const report = await readReport(f.root);
        expect(report["task.log"]).toBe(report["context.log"]);
        expect(report["context.log"]).not.toContain("unrelated");
        const repeated = await execute(platform, f.script, ["555d838a", ...options], f.cwd);
        expect(repeated.code, repeated.output).toBe(0);
        expect(await readdir(join(f.root, "backup/tmp"))).toHaveLength(2);
        expect(existsSync(join(f.root, "agents"))).toBe(false);
      } finally { await f.cleanup(); }
    }, 45_000);

    test("reports a missing task and an empty log directory without claiming success", async () => {
      const f = await fixture(platform);
      try {
        const empty = await execute(platform, f.script, ["555d838a"], f.cwd);
        expect(empty.code, empty.output).toBe(2);
        expect(existsSync(join(f.root, "backup/tmp"))).toBe(false);
        await writeFile(join(f.logs, "mixin-chatbot.log"), progress("任务开始", "准备会话", 0, 0, "abcdef12"));
        const result = await execute(platform, f.script, ["555d838a"], f.cwd);
        expect(result.code, result.output).toBe(2);
        const report = await readReport(f.root);
        expect(report["summary.txt"]).toContain("未找到任务");
        expect(report["task.log"]).toBe("");
        expect(report["context.log"]).toBe("");
      } finally { await f.cleanup(); }
    }, 45_000);

    test("rejects invalid IDs before creating output and provides non-interactive help", async () => {
      const f = await fixture(platform);
      try {
        for (const args of [[], ["../555d838a"], ["555d838a0"]]) {
          const result = await execute(platform, f.script, args, f.cwd);
          expect(result.code, result.output).toBe(1);
        }
        const help = await execute(platform, f.script, [platform === "powershell" ? "-Help" : "--help"], f.cwd);
        expect(help.code, help.output).toBe(0);
        expect(help.output).toContain("用法");
        expect(existsSync(join(f.root, "backup/tmp"))).toBe(false);
      } finally { await f.cleanup(); }
    }, 60_000);
  });
}
