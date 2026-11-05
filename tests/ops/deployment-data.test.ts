import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { deploymentDataPath, ownsDataMount } from "../../scripts/ops/core/deployment-data.ts";
import { tempFixture } from "../helpers/temp.ts";

test("数据目录是链接时按真实路径认定容器归属，与核心一致；只认唯一的可写绑定", async () => {
  const f = await tempFixture("deployment-data-");
  try {
    const project = join(f.root, "app"), target = join(f.root, "elsewhere/data");
    mkdirSync(project); mkdirSync(target, { recursive: true });
    expect(ownsDataMount(project, [{ Type: "bind", RW: true, Destination: "/app/data", Source: join(project, "data") }])).toBe(false);
    symlinkSync(target, join(project, "data"), "junction");
    const real = realpathSync(target), mount = { Type: "bind", RW: true, Destination: "/app/data", Source: real };
    expect(deploymentDataPath(project)).toBe(real);
    expect(ownsDataMount(project, [mount])).toBe(true);
    expect(ownsDataMount(project, [{ ...mount, Source: join(project, "data") }])).toBe(false);
    expect(ownsDataMount(project, [{ ...mount, RW: false }])).toBe(false);
    expect(ownsDataMount(project, [{ ...mount, Type: "volume" }])).toBe(false);
    expect(ownsDataMount(project, [mount, mount])).toBe(false);
    expect(ownsDataMount(project, undefined)).toBe(false);
  } finally { await f.cleanup(); }
});
