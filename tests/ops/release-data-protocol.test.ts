import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeReleaseData, parseReleaseDataArgs, releaseDataResult, type ReleaseDataCommand } from "../../scripts/lib/release-data-protocol.ts";
import { tempFixture } from "../helpers/temp.ts";
import { writeCurrentConfig } from "../helpers/current-config.ts";

const runner = join(import.meta.dir, "../../scripts/runtime/data-current.ts");
async function execute(root: string, action: string, extra: string[] = []) {
  const child = Bun.spawn([process.execPath, "--no-env-file", runner, action, "--json", "--project", root, "--deployment", "deploy-protocol", ...extra], {
    cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true, env: { ...process.env, BOT_OPERATION_LOG: "", APP_BUILD: "synthetic" },
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("数据工具协议要求命令、结果与实际退出码一致；结果总是 null", () => {
  expect(decodeReleaseData(JSON.stringify(releaseDataResult("apply", 0)), "apply", 0).success).toBe(true);
  expect(decodeReleaseData(JSON.stringify(releaseDataResult("rollback", 42)), "rollback", 42).success).toBe(false);
  const complete = releaseDataResult("apply", 0);
  for (const stdout of ["", JSON.stringify(complete) + "\nprogress", JSON.stringify({ ...complete, version: 2 }),
    JSON.stringify({ ...complete, command: "commit" }), JSON.stringify({ ...complete, exitCode: 1 }),
    JSON.stringify({ ...complete, success: false }), JSON.stringify({ ...complete, result: {} }),
    JSON.stringify({ ...complete, unknown: true }), JSON.stringify({ ...complete, result: undefined })])
    expect(() => decodeReleaseData(stdout, "apply", 0)).toThrow("不一致");
  expect(() => decodeReleaseData(JSON.stringify(complete), "apply", 3)).toThrow();
  expect(() => decodeReleaseData(JSON.stringify({ ...complete, result: { committed: true } }), "apply", 0)).toThrow("不一致");
});

test("数据工具严格检查参数，在打开日志或状态之前拒绝拼写错误、重复或缺值", async () => {
  expect(parseReleaseDataArgs(["preview", "--upgrade", "--json", "--project", "D:/合成项目", "--plan", "计划.json"]))
    .toEqual({ action: "preview", upgrade: true, json: true, project: "D:/合成项目", plan: "计划.json" });
  for (const args of [[], ["constructor"], ["committed"], ["apply", "--plans", "elsewhere"], ["apply", "--upgrade"], ["apply", "--project"],
    ["apply", "--json", "--json"], ["apply", "--project", "a", "--project", "b"], ["apply", "--plan", ""], ["apply", "--plan", "--json"]])
    expect(() => parseReleaseDataArgs(args)).toThrow();
  const f = await tempFixture("release-usage-");
  try {
    for (const action of ["apply", "rollback"]) {
      const value = await execute(f.root, action, ["--plans", "should-not-be-used"]);
      expect(value.code).toBe(1); expect(JSON.parse(value.stdout)).toMatchObject({ command: action, success: false, exitCode: 1 });
      expect(existsSync(join(f.root, "logs"))).toBe(false); expect(existsSync(join(f.root, "data"))).toBe(false);
    }
  } finally { await f.cleanup(); }
});

test("真实数据工具把中文说明送到 stderr，JSON 完整覆盖预览、准备、回滚和提交拒绝", async () => {
  const f = await tempFixture("release-json-");
  try {
    await writeCurrentConfig(f.root);
    const call = async (action: ReleaseDataCommand, expected = 0) => {
      const result = await execute(f.root, action, ["--plan", join(f.root, "plan.json")]);
      expect(result.code, result.stderr).toBe(expected);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      return { ...result, value: decodeReleaseData(result.stdout, action, result.code) };
    };
    const preview = await call("preview"); expect(preview.stderr).toContain("全新安装"); expect(preview.stdout).not.toContain("全新安装");
    await call("apply"); expect(JSON.parse(await readFile(join(f.root, "data/state/release-data.json"), "utf8")).phase).toBe("prepared");
    await call("rollback"); expect(existsSync(join(f.root, "data/state/release-data.json"))).toBe(false);
    await call("apply"); await call("commit");
    const committed = await readFile(join(f.root, "data/state/release-data.json"), "utf8");
    expect(JSON.parse(committed).phase).toBe("committed");
    expect((await call("rollback", 42)).value.success).toBe(false);
    expect(await readFile(join(f.root, "data/state/release-data.json"), "utf8")).toBe(committed);
  } finally { await f.cleanup(); }
}, 60_000);

test("数据工具读取失败有完整失败结果，保留未知版本标记", async () => {
  const f = await tempFixture("release-json-refusal-");
  try {
    await mkdir(join(f.root, "data/state"), { recursive: true });
    await writeFile(join(f.root, "data/state/data-version.json"), "invalid-metadata");
    const result = await execute(f.root, "check");
    expect(result.code).toBe(1); expect(decodeReleaseData(result.stdout, "check", 1).success).toBe(false);
    expect(result.stdout).not.toContain("invalid-metadata");
    expect(await readFile(join(f.root, "data/state/data-version.json"), "utf8")).toBe("invalid-metadata");
  } finally { await f.cleanup(); }
});
