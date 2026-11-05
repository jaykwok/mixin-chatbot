import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { applyConfiguration, assertRestorable, restoreConfiguration, finishConfiguration } from "../../scripts/config/configuration-transaction.ts";
import { configurationSnapshot, CONFIGURATION_FILES } from "../../scripts/config/configuration-form.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { assessMaintenanceAction, MAINTENANCE_INTENTS, readMaintenanceState } from "../../src/core/maintenance-state.ts";
import { tempFixture } from "../helpers/temp.ts";

const id = "config-" + "a".repeat(32);
function fixtureFiles(root: string) {
  for (const key of ["models", "settings", "catalog"] as const) {
    const path = join(root, CONFIGURATION_FILES[key]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ test: key, secret: "old-private" }));
  }
  const base = configurationSnapshot(root, "models"), next = structuredClone(base);
  for (const key of ["models", "settings", "catalog"] as const) next.files[key] = JSON.stringify({ test: key, secret: "new-private" });
  return { base, next };
}

test("多文件配置在发布到一半时阻止启动，恢复保持逐字节原值；就绪后才允许启动及完成", async () => {
  const f = await tempFixture("configuration-transaction-");
  try {
    const { base, next } = fixtureFiles(f.root);
    await expect(applyConfiguration(f.root, id, base, next, async point => { if (point === "installed:models") throw new Error("injected"); })).rejects.toThrow("injected");
    const partial = readMaintenanceState(f.root);
    expect(assessMaintenanceAction(partial, "service").allowed).toBe(false); expect(assessMaintenanceAction(partial, "configuration-restore").allowed).toBe(true);
    await restoreConfiguration(f.root, id); expect(configurationSnapshot(f.root, "models")).toEqual(base);
    expect(readConfigurationState(f.root)?.phase).toBe("rolled-back"); expect(assessMaintenanceAction(readMaintenanceState(f.root), "service").allowed).toBe(true);
    await finishConfiguration(f.root, id); expect(readConfigurationState(f.root)).toBeNull();
    await applyConfiguration(f.root, id, base, next); expect(configurationSnapshot(f.root, "models")).toEqual(next);
    expect(readConfigurationState(f.root)?.phase).toBe("ready"); expect(assessMaintenanceAction(readMaintenanceState(f.root), "service").allowed).toBe(true);
    await finishConfiguration(f.root, id); expect(readConfigurationState(f.root)).toBeNull();
  } finally { await f.cleanup(); }
});

test("恢复材料损坏或正式文件被第三方修改时不覆盖；未知状态拒绝所有维护动作", async () => {
  const f = await tempFixture("configuration-restore-guard-");
  try {
    const { base, next } = fixtureFiles(f.root); await applyConfiguration(f.root, id, base, next);
    const original = join(f.root, "data/config", "." + id, "models.before"), saved = readFileSync(original, "utf8");
    writeFileSync(original, saved.replace("old-private", "bad-private"));
    await expect(restoreConfiguration(f.root, id)).rejects.toThrow("摘要不符"); expect(configurationSnapshot(f.root, "models")).toEqual(next);
    writeFileSync(original, saved); writeFileSync(join(f.root, CONFIGURATION_FILES.settings), '{"third":true}');
    await expect(restoreConfiguration(f.root, id)).rejects.toThrow("其他操作修改");
    expect(readFileSync(join(f.root, CONFIGURATION_FILES.models), "utf8")).toContain("new-private");
    writeFileSync(join(f.root, "data/state/configuration-change.json"), '{"version":999}');
    const state = readMaintenanceState(f.root); for (const intent of MAINTENANCE_INTENTS) expect(assessMaintenanceAction(state, intent).allowed).toBe(false);
  } finally { await f.cleanup(); }
});

test("就绪后被第三方改过的事务：停机前的只读核对拒绝且不改阶段；恢复本身仍记 restoring、阻止启动；文件改回后可完成", async () => {
  const f = await tempFixture("configuration-restore-third-party-");
  try {
    const { base, next } = fixtureFiles(f.root); await applyConfiguration(f.root, id, base, next);
    const settings = join(f.root, CONFIGURATION_FILES.settings);
    writeFileSync(settings, '{"third":true}');
    // The operator's restore-check: refused, nothing written, the running service may keep running.
    expect(() => assertRestorable(f.root, id)).toThrow("已被其他操作修改");
    expect(readConfigurationState(f.root)?.phase).toBe("ready");
    expect(assessMaintenanceAction(readMaintenanceState(f.root), "service").allowed).toBe(true);
    // Recovering a failed change: the deployment stays stopped with the foreign bytes kept.
    await expect(restoreConfiguration(f.root, id)).rejects.toThrow("已被其他操作修改");
    expect(readConfigurationState(f.root)?.phase).toBe("restoring");
    expect(assessMaintenanceAction(readMaintenanceState(f.root), "service").allowed).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe('{"third":true}');
    // Every file back at its old bytes (by hand): the restore completes without writing.
    for (const key of ["models", "settings", "catalog"] as const) writeFileSync(join(f.root, CONFIGURATION_FILES[key]), base.files[key]!);
    expect(() => assertRestorable(f.root, id)).not.toThrow();
    await restoreConfiguration(f.root, id); expect(readConfigurationState(f.root)?.phase).toBe("rolled-back");
    await finishConfiguration(f.root, id); expect(configurationSnapshot(f.root, "models")).toEqual(base);
  } finally { await f.cleanup(); }
});

test("新增与停用配置回滚分别恢复缺失与原文件；恢复途中再中断可重做", async () => {
  const f = await tempFixture("configuration-new-file-");
  try {
    const base = configurationSnapshot(f.root, "relay"), next = { ...base, files: { relay: '{"fixture":"new-private"}' } };
    await applyConfiguration(f.root, id, base, next);
    await expect(restoreConfiguration(f.root, id, async point => { if (point === "restored:relay") throw new Error("interrupted"); })).rejects.toThrow("interrupted");
    expect(assessMaintenanceAction(readMaintenanceState(f.root), "service").allowed).toBe(false);
    await restoreConfiguration(f.root, id); await finishConfiguration(f.root, id); expect(configurationSnapshot(f.root, "relay")).toEqual(base);
    writeFileSync(join(f.root, CONFIGURATION_FILES.relay), '{"fixture":"existing-private"}');
    const old = configurationSnapshot(f.root, "relay"); await applyConfiguration(f.root, id, old, { ...old, files: { relay: null } });
    expect(configurationSnapshot(f.root, "relay").files.relay).toBeNull(); await restoreConfiguration(f.root, id); await finishConfiguration(f.root, id);
    expect(configurationSnapshot(f.root, "relay")).toEqual(old);
  } finally { await f.cleanup(); }
});

test("配置发布在每个文件边界被强杀后，磁盘状态可判断并恢复原整套配置", async () => {
  for (const point of ["prepared", "installed:models", "installed:settings", "installed:catalog", "ready"]) {
    const f = await tempFixture("configuration-kill-");
    try {
      const values = fixtureFiles(f.root), material = join(f.root, "synthetic.json"); writeFileSync(material, JSON.stringify(values));
      const module = pathToFileURL(fileURLToPath(new URL("../../scripts/config/configuration-transaction.ts", import.meta.url))).href;
      const runner = join(f.root, "kill-fixture.ts");
      writeFileSync(runner, `import { applyConfiguration } from ${JSON.stringify(module)}; const [project, id, point] = process.argv.slice(2); const { base, next } = await Bun.file(project + '/synthetic.json').json(); await applyConfiguration(project, id, base, next, async value => { if (value === point) { console.log('AT_POINT'); await new Promise(() => {}); } });`);
      const child = Bun.spawn([process.execPath, runner, f.root, id, point], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const errors = new Response(child.stderr).text(); const reader = child.stdout.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("未到达强杀点 " + point)), 15000); })]);
        expect(new TextDecoder().decode(chunk.value)).toContain("AT_POINT");
      } finally { clearTimeout(timer); reader.releaseLock(); child.kill(9); await child.exited; }
      expect(await errors).toBe(""); expect(readConfigurationState(f.root)?.phase).toBe(point === "ready" ? "ready" : "publishing");
      await restoreConfiguration(f.root, id); expect(configurationSnapshot(f.root, "models")).toEqual(values.base);
      await finishConfiguration(f.root, id); expect(readConfigurationState(f.root)).toBeNull();
    } finally { await f.cleanup(); }
  }
}, 90000);
