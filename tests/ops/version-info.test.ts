// Operator version facts (scripts/ops/version-info.ts): the running program from /health, else the deployment record;
// the local checkout only appears as its own row when it differs.
import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { healthProgram, shortBuild, versionFacts, versionRows } from "../../scripts/ops/version-info.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("version-info-");
afterAll(() => fixture.cleanup());
let counter = 0;
async function project(version: string, record?: unknown): Promise<string> {
  const root = join(fixture.root, `p${++counter}`);
  await mkdir(join(root, "data", "state"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mixin-chatbot", version }));
  if (record !== undefined) await writeFile(join(root, "data", "state", "data-version.json"), typeof record === "string" ? record : JSON.stringify(record));
  return root;
}
const deployed = { dataVersion: 1, appVersion: "1.0.0", build: "abc1234def5678", transaction: "deploy-x" };

test("the running service names the version; the same local tool adds no row", async () => {
  const root = await project("1.0.0", deployed);
  const rows = versionRows(versionFacts(root, { appVersion: "1.0.0", build: "abc1234def5678" }, "abc1234def5678"));
  expect(rows).toEqual([["应用机器人", "v1.0.0"], ["构建", "abc1234"], ["数据格式", "1"]]);
});

test("a newer local tool is shown next to the running service, never in its place", async () => {
  const root = await project("1.1.0", deployed);
  const rows = versionRows(versionFacts(root, { appVersion: "1.0.0", build: "abc1234def5678" }, "91813d1c4e2a"));
  expect(rows[0]).toEqual(["应用机器人", "v1.0.0"]);
  expect(rows).toContainEqual(["本地工具", "v1.1.0 · 运行服务 v1.0.0"]);
  // Same version, other build: the builds tell them apart.
  const same = versionRows(versionFacts(await project("1.0.0", deployed), { appVersion: "1.0.0", build: "abc1234def5678" }, "91813d1c4e2a-dirty"));
  expect(same).toContainEqual(["本地工具", "v1.0.0 构建 91813d1-dirty · 运行服务 v1.0.0 构建 abc1234"]);
});

test("without a running service the deployment record speaks, marked as such; the checkout never stands in", async () => {
  const root = await project("1.1.0", deployed);
  const rows = versionRows(versionFacts(root, undefined, "91813d1c4e2a"));
  expect(rows[0]).toEqual(["应用机器人", "v1.0.0（未运行，取自部署记录）"]);
  expect(rows).toContainEqual(["本地工具", "v1.1.0 · 已部署 v1.0.0"]);
  expect(versionRows(versionFacts(await project("1.0.0"), undefined, "x"))).toEqual([["应用机器人", "尚未部署"], ["数据格式", "—"]]);
});

test("a legacy record without a program version or a damaged record is reported, not guessed from the checkout", async () => {
  const legacy = versionRows(versionFacts(await project("1.0.0", { dataVersion: 5, transaction: "old" }), undefined, "x"));
  expect(legacy[0]).toEqual(["应用机器人", "未知：部署记录没有程序版本（旧版数据）"]);
  const damaged = versionRows(versionFacts(await project("1.0.0", "{broken"), undefined, "x"));
  expect(damaged[0]![1]).toStartWith("未知：无法读取版本状态");
});

test("only a /health body with appVersion names a program; builds shorten to seven characters", () => {
  expect(healthProgram({ service: "mixin-chatbot", version: 1, appVersion: "1.0.0", build: "abc1234def" })).toEqual({ appVersion: "1.0.0", build: "abc1234def" });
  expect(healthProgram({ service: "mixin-chatbot", version: 1 })).toBeUndefined();
  expect(healthProgram(null)).toBeUndefined();
  expect(shortBuild("abc1234def5678-dirty")).toBe("abc1234-dirty");
  expect(shortBuild("")).toBe("");
});
