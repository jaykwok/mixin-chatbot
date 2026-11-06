import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readRuntimeSettings } from "../../ops/config/runtime-draft.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { tempFixture } from "../helpers/temp.ts";

test("运行参数数据 CLI 使用 stdin 与完整结果；环境冲突、错拼参数或摘要不符不写入；配置事务可恢复", async () => {
  const f = await tempFixture("runtime-apply-cli-"), id = "config-" + "a".repeat(32);
  try {
    const path = join(f.root, "data/config/runtime.json"); await mkdir(join(f.root, "data/config"), { recursive: true });
    // Restoring gives back the original bytes, line endings included.
    const original = '{\r\n  "BOT_MAX_ACTIVE_REQUESTS": "32",\r\n  "BOT_HOST": "127.0.0.1"\r\n}\r\n'; await writeFile(path, original);
    const raw = JSON.stringify({ expectedHash: (await readRuntimeSettings(path)).hash, changes: { BOT_MAX_ACTIVE_REQUESTS: "64" } });
    const hash = (text: string) => createHash("sha256").update(text).digest("hex"), digest = hash(raw);
    const run = async (action: string, input = raw, extra: string[] = [], override?: string, sum = digest) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../../ops/config/runtime-apply.ts"), action,
        "--id", id, "--digest", sum, "--stdin", "--json", ...extra], { cwd: f.root, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, BOT_MAX_ACTIVE_REQUESTS: override } });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(out + err).not.toContain("private-fixture-secret"); return { code, value: JSON.parse(out) as { outcome: string; message?: string } };
    };
    expect(await run("check")).toMatchObject({ code: 0, value: { command: "check", outcome: "success", result: null } });
    // The reason is passed on, except a JSON syntax error, which can quote the bytes it stopped at.
    expect(await run("check", raw, [], "8")).toMatchObject({ code: 1, value: { outcome: "failed", message: expect.stringContaining("BOT_MAX_ACTIVE_REQUESTS 被显式环境变量覆盖") } });
    expect(await run("apply", "private-fixture-secret")).toMatchObject({ code: 1, value: { message: expect.stringContaining("摘要不符") } });
    const broken = '{"expectedHash":"private-fixture-secret';
    expect(await run("apply", broken, [], undefined, hash(broken))).toMatchObject({ code: 1, value: { outcome: "failed", message: expect.stringContaining("不是有效 JSON") } });
    expect(await run("apply", raw, ["--digests", digest])).toMatchObject({ code: 1, value: { outcome: "refused" } });
    expect(await readFile(path, "utf8")).toBe(original); expect(readConfigurationState(f.root)).toBeNull();
    expect(await run("apply")).toMatchObject({ code: 0, value: { command: "apply", outcome: "success", result: null } });
    expect(readConfigurationState(f.root)).toMatchObject({ id, kind: "runtime", phase: "ready" });
    expect((await readRuntimeSettings(path)).values).toEqual({ BOT_HOST: "127.0.0.1", BOT_MAX_ACTIVE_REQUESTS: "64" });
    const restore = async () => {
      for (const action of ["restore", "finish"]) {
        const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../../ops/config/configuration-apply.ts"), action, "--id", id, "--json"],
          { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, err).toBe(0); expect(JSON.parse(out)).toMatchObject({ outcome: "success", result: null });
      }
    };
    await restore();
    expect(await readFile(path, "utf8")).toBe(original); expect(readConfigurationState(f.root)).toBeNull();
    // A first runtime.json: restoring removes it again.
    await rm(path);
    const fresh = JSON.stringify({ expectedHash: null, changes: { BOT_MAX_ACTIVE_REQUESTS: "64" } });
    expect(await run("apply", fresh, [], undefined, hash(fresh))).toMatchObject({ code: 0, value: { outcome: "success" } });
    expect((await readRuntimeSettings(path)).values).toEqual({ BOT_MAX_ACTIVE_REQUESTS: "64" });
    await restore();
    expect(existsSync(path)).toBe(false); expect(readConfigurationState(f.root)).toBeNull();
  } finally { await f.cleanup(); }
}, 30_000);
