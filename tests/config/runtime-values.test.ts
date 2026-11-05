import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuntimeValues, runtimeDigest, runtimeText } from "../../scripts/config/runtime-values.ts";
import { RUNTIME_KEYS } from "../../src/core/runtime-schema.ts";
import { tempFixture } from "../helpers/temp.ts";

const script = fileURLToPath(new URL("../../scripts/config/runtime-settings.ts", import.meta.url));
const image = "sha256:" + "a".repeat(64);

/** The real CLI in `project`; the caller's environment never contributes a runtime key. */
async function run(project: string, args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const key of RUNTIME_KEYS) delete base[key];
  const child = Bun.spawn([process.execPath, script, ...args], { cwd: project, env: { ...base, ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("部署停机前算出运行参数：现有文件加上环境中受支持的键；Docker 不取工作目录和任务运行时，默认工作目录不写入；runtime.json 不变", async () => {
  const f = await tempFixture("runtime-prepare-");
  try {
    const runtime = join(f.root, "data/config/runtime.json"), current = '{\n  "BOT_PORT": "1011",\n  "BOT_MAX_ACTIVE_REQUESTS": "16"\n}\n';
    await mkdir(join(f.root, "data/config"), { recursive: true }); await writeFile(runtime, current);
    const environment = { BOT_PORT: "2022", WORKSPACE_ROOT: join(f.root, "shared"), BOT_TASK_IMAGE: image, BOT_CLOSEOUT_SECONDS: " 60 ", UNRELATED: "x" };
    const docker = join(f.root, "stage-docker/runtime-values.json");
    expect(await run(f.root, ["--prepare-values", docker, "--deployment", "docker"], environment)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(parseRuntimeValues(await readFile(docker, "utf8"))).toEqual({ format: 1, base: runtimeDigest(current),
      values: { BOT_PORT: "2022", BOT_MAX_ACTIVE_REQUESTS: "16", BOT_CLOSEOUT_SECONDS: "60" } });
    if (process.platform !== "win32") expect((await stat(docker)).mode & 0o777).toBe(0o600);

    const windows = join(f.root, "stage-windows/runtime-values.json");
    expect((await run(f.root, ["--prepare-values", windows, "--deployment", "windows"], environment)).code).toBe(0);
    expect(parseRuntimeValues(await readFile(windows, "utf8")).values).toEqual({ BOT_PORT: "2022", BOT_MAX_ACTIVE_REQUESTS: "16", BOT_CLOSEOUT_SECONDS: "60",
      WORKSPACE_ROOT: join(f.root, "shared"), BOT_TASK_IMAGE: image });
    const fallback = join(f.root, "stage-default/runtime-values.json");
    expect((await run(f.root, ["--prepare-values", fallback, "--deployment", "windows"], { WORKSPACE_ROOT: join(f.root, "data", "workspace") })).code).toBe(0);
    expect(parseRuntimeValues(await readFile(fallback, "utf8")).values).toEqual({ BOT_PORT: "1011", BOT_MAX_ACTIVE_REQUESTS: "16" });
    expect(await readFile(runtime, "utf8")).toBe(current);

    // An existing stage file is never replaced; bad input writes nothing.
    const again = await run(f.root, ["--prepare-values", docker, "--deployment", "docker"]);
    expect(again.code).toBe(1);
    for (const [args, env, message] of [
      [["--prepare-values", join(f.root, "bad-port.json"), "--deployment", "docker"], { BOT_PORT: "0" }, "BOT_PORT 必须是 1-65535 的整数"],
      [["--prepare-values", join(f.root, "no-deployment.json")], {}, "需要 --deployment"],
      [["--prepare-values", join(f.root, "bad-deployment.json"), "--deployment", "linux"], {}, "只能是 docker 或 windows"],
    ] as const) {
      const failed = await run(f.root, [...args], env);
      expect([failed.code, failed.stdout], args.join(" ")).toEqual([1, ""]); expect(failed.stderr).toContain(message);
      expect(existsSync(args[1]!)).toBe(false);
    }
    await writeFile(runtime, '{"BOT_PORT": "1011",');
    const broken = await run(f.root, ["--prepare-values", join(f.root, "broken.json"), "--deployment", "docker"]);
    expect(broken.code).toBe(1); expect(broken.stderr).toContain("data/config/runtime.json 无效：不是有效 JSON");
  } finally { await f.cleanup(); }
});

test("停机后安装运行参数：维护租约内写入，已在位时不重写，停机前确认之后被改动时拒绝；只输出 JSON 结果", async () => {
  const f = await tempFixture("runtime-values-");
  try {
    const runtime = join(f.root, "data/config/runtime.json"), file = join(f.root, "stage/runtime-values.json");
    expect((await run(f.root, ["--prepare-values", file, "--deployment", "docker"], { BOT_PORT: "2022", BOT_ATTACHMENT_CONCURRENCY: "4" })).code).toBe(0);
    const install = async (...extra: string[]) => {
      const result = await run(f.root, ["--values", file, ...extra]);
      return { ...result, json: JSON.parse(result.stdout) as Record<string, unknown> & { command: string; outcome: string; result?: unknown; message?: string } };
    };
    const done = await install("--json");
    expect([done.code, done.json]).toEqual([0, { protocol: "mixin-maintenance", version: 1, command: "values", outcome: "success", result: { installed: true } }]);
    expect(await readFile(runtime, "utf8")).toBe(runtimeText({ BOT_PORT: "2022", BOT_ATTACHMENT_CONCURRENCY: "4" }));
    if (process.platform !== "win32") expect((await stat(runtime)).mode & 0o777).toBe(0o600);
    expect((await install("--json")).json.result).toEqual({ installed: false });

    await writeFile(runtime, '{\n  "BOT_PORT": "3033"\n}\n');
    const changed = await install("--json");
    expect([changed.code, changed.json.outcome]).toEqual([1, "failed"]); expect(changed.json.message).toContain("在停机前确认之后被改动");
    expect(await readFile(runtime, "utf8")).toBe('{\n  "BOT_PORT": "3033"\n}\n');

    for (const extra of [[], ["--json", "--json"], ["--json", "--plan", "x"]]) {
      const usage = await install(...extra);
      expect([usage.code, usage.json.command, usage.json.outcome], extra.join(" ")).toEqual([1, "values", "refused"]);
    }
    await writeFile(file, '{"format":1,"base":null,"values":{"BOT_PORT":"99999"}}');
    const invalid = await install("--json");
    expect(invalid.json.outcome).toBe("failed"); expect(invalid.json.message).toContain("BOT_PORT 必须是 1-65535 的整数");
    const missing = await run(f.root, ["--values", join(f.root, "missing.json"), "--json"]);
    expect(JSON.parse(missing.stdout).message).toBe("运行参数没有写入：运行参数暂存无法读取");
  } finally { await f.cleanup(); }
});
