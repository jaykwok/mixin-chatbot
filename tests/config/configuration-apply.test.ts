import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationDigest } from "../../scripts/config/configuration-draft.ts";
import { configurationSnapshot } from "../../scripts/config/configuration-form.ts";
import { ConfigurationDrafts } from "../../scripts/ops/console/configuration-drafts.ts";
import { readConfigurationState, configurationStateDigest, CONFIGURATION_STATE_FILE } from "../../src/core/configuration-state.ts";
import { tempFixture } from "../helpers/temp.ts";

test("配置提交 CLI 校验摘要并持维护租约；草稿只经 stdin 传入，发布与恢复保留协议；被第三方改过的事务在停机前的核对里就拒绝", async () => {
  const f = await tempFixture("configuration-cli-");
  try {
    const drafts = new ConfigurationDrafts(f.root), view = drafts.create("app", "test");
    const key = "private-fixture-secret", path = join(f.root, "data/config/app-bot.json");
    drafts.edit(view.id, "test", view.revision, { appId: "fixture", environment: "production", secret: { mode: "set", value: key } });
    const input = drafts.validationInput(view.id, "test", 1); drafts.validated(view.id, "test", 1, input.digest, ["通过"]);
    const { digest } = drafts.prepare(view.id, "test");
    const invoke = async (action: string, options: string[], stdin?: string) => {
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../scripts/config/configuration-apply.ts", import.meta.url)), action,
        "--id", view.id, ...options, "--json"], { cwd: f.root, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(out + err).not.toContain(key); return { code, value: JSON.parse(out) as { outcome: string; message?: string } };
    };
    const body = await readFile(drafts.path(view.id), "utf8");
    expect(await invoke("check", ["--digest", digest])).toMatchObject({ code: 1, value: { outcome: "refused", message: expect.stringContaining("--stdin") } });
    expect(await invoke("check", ["--digest", digest, "--stdin"], body)).toMatchObject({ code: 0, value: { protocol: "mixin-maintenance", command: "check", outcome: "success", result: null } });
    expect(await invoke("apply", ["--digest", "a".repeat(64), "--stdin"], body)).toMatchObject({ code: 1, value: { outcome: "failed", message: expect.stringContaining("没有通过校验或已变化") } });
    expect(readConfigurationState(f.root)).toBeNull();
    expect(await invoke("apply", ["--digest", digest, "--stdin"], body)).toMatchObject({ code: 0, value: { outcome: "success" } });
    expect(readConfigurationState(f.root)?.phase).toBe("ready"); expect(await readFile(path, "utf8")).toContain(key);
    const readyDigest = configurationStateDigest(readConfigurationState(f.root)!);
    expect(await invoke("restore-check", ["--expect", readyDigest])).toMatchObject({ code: 0 });
    expect(await invoke("restore", ["--expect", "0".repeat(64)])).toMatchObject({ code: 1 });
    expect(readConfigurationState(f.root)?.phase).toBe("ready");
    // An unrelated writer must not be overwritten by the recovery command.
    const applied = await readFile(path, "utf8"); await writeFile(path, "{}");
    // Before the stop: refused, nothing written (the phase stays ready, which does not keep the service from starting).
    expect(await invoke("restore-check", ["--expect", readyDigest])).toMatchObject({ code: 1, value: { outcome: "failed", message: expect.stringContaining("已被其他操作修改") } });
    expect(readConfigurationState(f.root)?.phase).toBe("ready");
    expect(await invoke("restore", [])).toMatchObject({ code: 1, value: { outcome: "failed", message: expect.stringContaining("已被其他操作修改") } });
    expect(await invoke("restore", ["--expect", readyDigest])).toMatchObject({ code: 1 });
    expect(readConfigurationState(f.root)?.phase).toBe("restoring");
    await writeFile(path, applied);
    expect(await invoke("restore", [])).toMatchObject({ code: 0, value: { outcome: "success" } });
    expect(readConfigurationState(f.root)?.phase).toBe("rolled-back");
    expect(await invoke("finish", [])).toMatchObject({ code: 0, value: { outcome: "success" } });
    expect(readConfigurationState(f.root)).toBeNull();
    // A crash after the commit marker only permits finishing; recovery must not undo acknowledged configuration.
    expect(await invoke("apply", ["--digest", digest, "--stdin"], body)).toMatchObject({ code: 0 });
    const committed = { ...readConfigurationState(f.root)!, phase: "committed" as const };
    await writeFile(join(f.root, CONFIGURATION_STATE_FILE), JSON.stringify(committed));
    expect(await invoke("restore", ["--expect", configurationStateDigest(committed)])).toMatchObject({ code: 0 });
    expect(readConfigurationState(f.root)).toBeNull(); expect(await readFile(path, "utf8")).toContain(key);
    expect(await invoke("apply", ["--digest", digest, "--no-check"])).toMatchObject({ code: 1, value: { outcome: "refused" } });
    // A draft whose configuration is not JSON (digest and validation forged to match): the parser's message is not passed on.
    const forged = JSON.parse(await readFile(drafts.path(view.id), "utf8")), base = configurationSnapshot(f.root, "app");
    const next = { ...base, files: { app: '{"appSecret":"' + key } };
    const forgedDigest = configurationDigest({ base, next }), forgedBody = JSON.stringify({ ...forged, base, next, validated: { ...forged.validated, digest: forgedDigest } });
    expect(await invoke("check", ["--digest", forgedDigest, "--stdin"], forgedBody)).toMatchObject({ code: 1, value: { outcome: "failed", message: expect.stringContaining("配置不是有效 JSON") } });
  } finally { await f.cleanup(); }
}, 30_000);
