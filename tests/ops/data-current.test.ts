import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_VERSION, inspectDataVersion } from "../../src/core/data-version.ts";
import { writeCurrentConfig } from "../helpers/current-config.ts";
import { tempFixture } from "../helpers/temp.ts";

const runner = fileURLToPath(new URL("../../scripts/runtime/data-current.ts", import.meta.url));
const deployment = "deploy-current123";
async function run(project: string, action: string, groups = join(project, "groups"), id = deployment) {
  const child = Bun.spawn([process.execPath, runner, action, "--project", project, "--groups", groups,
    "--deployment", id, "--plan", join(project, "plan.json")], { cwd: project,
    env: { ...process.env, BOT_OPERATION_LOG: "", BOT_MODEL_CACHE_RETENTION: "" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, text: out + err };
}

for (const linked of ["project", "groups"] as const) for (const finish of ["commit", "rollback"] as const)
  test(`ordinary ${finish} supports a linked ${linked} without a reset journal`, async () => {
    const f = await tempFixture("current-junction-");
    try {
      const realProject = join(f.root, "real-project"), realGroups = join(realProject, "groups");
      await writeCurrentConfig(realProject); await mkdir(realGroups, { recursive: true });
      const alias = join(f.root, "alias");
      await symlink(linked === "project" ? realProject : realGroups, alias, process.platform === "win32" ? "junction" : "dir");
      const project = linked === "project" ? alias : realProject, groups = linked === "groups" ? alias : join(project, "groups");
      await mkdir(join(project, "data/state"), { recursive: true });
      for (const path of [join(project, "data/state/data-version.json"), join(groups, "data-version.json")])
        await writeFile(path, JSON.stringify({ dataVersion: DATA_VERSION, transaction: "previous" }));
      await writeFile(join(groups, "sentinel.txt"), "keep");
      for (const action of ["preview", "apply", finish, ...(finish === "commit" ? ["finish-reset", "finish-reset"] : ["rollback"])]) {
        const result = await run(project, action, groups); expect(result.code, result.text).toBe(0);
      }
      expect(await readFile(join(realGroups, "sentinel.txt"), "utf8")).toBe("keep");
      expect(existsSync(join(realProject, "backup/snapshots", deployment, "reset.json"))).toBe(false);
    } finally { await f.cleanup(); }
  }, 60000);

test("fresh registration validates offline, preserves workspace, commits paired markers and refuses rollback after commit", async () => {
  const f = await tempFixture("current-registration-");
  try {
    await writeCurrentConfig(f.root);
    const workspace = join(f.root, "groups/g/workspace"); await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "reference.txt"), "keep");
    for (const action of ["preview", "apply", "apply", "validate", "commit", "commit", "committed"]) {
      const result = await run(f.root, action); expect(result.code, result.text).toBe(0);
    }
    expect(inspectDataVersion(f.root, join(f.root, "groups")).current).toBe(true);
    expect(JSON.parse(await readFile(join(f.root, "groups/data-version.json"), "utf8"))).toEqual({ dataVersion: DATA_VERSION, transaction: deployment });
    expect((await run(f.root, "rollback")).code).toBe(42);
    expect((await run(f.root, "committed", join(f.root, "elsewhere"))).code).toBe(1);
    expect(await readFile(join(workspace, "reference.txt"), "utf8")).toBe("keep");
  } finally { await f.cleanup(); }
});

for (const finish of ["commit", "rollback"] as const) for (const partial of ["local", "group"] as const)
  test(`interrupted ${partial} marker can ${finish} without converters or losing carried files`, async () => {
    const f = await tempFixture("current-interrupted-");
    try {
      await writeCurrentConfig(f.root);
      expect((await run(f.root, "preview")).code).toBe(0);
      expect((await run(f.root, "apply")).code).toBe(0);
      const path = join(f.root, partial === "local" ? "data/state" : "groups", "data-version.json");
      await writeFile(path, JSON.stringify({ dataVersion: DATA_VERSION, transaction: deployment }));
      expect((await run(f.root, "apply")).code).toBe(0);
      const result = await run(f.root, finish); expect(result.code, result.text).toBe(0);
      expect(inspectDataVersion(f.root, join(f.root, "groups")).current).toBe(finish === "commit");
      if (finish === "rollback") {
        for (const item of ["data/state/data-version.json", "groups/data-version.json", "data/state/release-data.json"])
          expect(existsSync(join(f.root, item))).toBe(false);
      }
    } finally { await f.cleanup(); }
  });

test("old or mismatched stores, old tasks, bad model configuration and competing registrations are refused", async () => {
  const f = await tempFixture("current-refusals-");
  try {
    await writeCurrentConfig(f.root);
    await mkdir(join(f.root, "groups/g/users"), { recursive: true });
    expect((await run(f.root, "preview")).text).toContain("未登记的群根含运行数据");
    const current = join(f.root, "fresh");
    expect((await run(f.root, "preview", current)).code).toBe(0);
    expect((await run(f.root, "apply", current)).code).toBe(0);
    expect((await run(f.root, "apply", current, "deploy-other")).text).toContain("另一次发布尚未完成");
    await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 5, transaction: "old" }));
    expect((await run(f.root, "commit", current)).text).toContain("仅支持当前数据格式");
    expect(JSON.parse(await readFile(join(f.root, "data/state/data-version.json"), "utf8")).dataVersion).toBe(5);
  } finally { await f.cleanup(); }
});
