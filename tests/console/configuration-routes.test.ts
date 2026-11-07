import { expect, test } from "bun:test";
import { ConfigurationDrafts } from "../../ops/core/configuration-drafts.ts";
import { configurationQuery, configurationRoutes } from "../../console/server/configuration-routes.ts";
import type { RouteContext } from "../../console/server/routes.ts";
import { tempFixture } from "../helpers/temp.ts";
import { join } from "node:path";
import { SOURCE_DIR } from "../../ops/core/platform.ts";
import type { QueryHost } from "../../console/server/runtime-query.ts";

/** The container path, whatever the runner: Linux hosts query through the deployed image. */
const linux: QueryHost = { platform: "linux", service: async () => null };

/** The bot container reports its data bind by the real path it was created with. */
const dataMount = (root: string) => { mkdirSync(join(root, "data"), { recursive: true }); return { Type: "bind", RW: true, Destination: "/app/data", Source: realpathSync(join(root, "data")) }; };
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

test("恢复状态只投影配置与维护标记，覆盖发布前中断、运行参数和已收尾记录；损坏状态拒绝", async () => {
  const f = await tempFixture("configuration-recovery-route-");
  try {
    const dir = join(f.root, "data/state"); mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "configuration-change.json"), opsPath = join(dir, "ops-maintenance.json");
    const route = configurationRoutes(new ConfigurationDrafts(f.root))["GET /api/configuration/state"]!;
    const query = () => route.run({} as RouteContext), id = "config-" + "a".repeat(32);
    const original = { identity: "b".repeat(64), state: "running", owned: true, pending: false, ready: true };
    const record = { version: 1, checkpoint: { version: 1, phase: "prepared", original,
      request: { id: "c".repeat(32), command: "runtime-configure", label: "fixture-private-label", runtime: "d".repeat(64), intent: "configuration", configuration: id } } };
    expect(await query()).toEqual({ transaction: null, maintenancePending: false });
    writeFileSync(opsPath, JSON.stringify(record));
    expect(await query()).toEqual({ transaction: null, maintenancePending: true });
    const transaction = { id, phase: "ready", kind: "runtime" };
    writeFileSync(configPath, JSON.stringify({ version: 1, ...transaction, binding: null,
      rows: [{ key: "runtime", before: null, after: "e".repeat(64) }] }));
    expect(await query()).toEqual({ transaction, maintenancePending: true });
    writeFileSync(opsPath, JSON.stringify({ ...record, result: { protocol: "mixin-ops", version: 1, command: "runtime-configure",
      outcome: "failed", wasRunning: true, finalState: "stopped", exitCode: 1, message: "fixture-private-message" } }));
    expect(await query()).toEqual({ transaction, maintenancePending: false });
    rmSync(opsPath); expect(await query()).toEqual({ transaction, maintenancePending: false });
    for (const path of [opsPath, configPath]) {
      writeFileSync(path, '{"version":999,"secret":"fixture-do-not-display"}');
      let error: unknown; try { await query(); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ status: 409 }); expect(String(error)).not.toContain("fixture-do-not-display");
      expect(String(error)).not.toContain("正式配置未修改"); rmSync(path);
    }
  } finally { await f.cleanup(); }
});

test("配置路由绑定登录与修订，秘密和缓存不出现在响应里；修改或退出后的迟到校验被拒", async () => {
  const f = await tempFixture("configuration-routes-");
  try {
    const drafts = new ConfigurationDrafts(f.root); let resolveCheck: (value: unknown) => void = () => {};
    const routes = configurationRoutes(drafts, async () => new Promise(resolve => { resolveCheck = resolve; }));
    const context = (body: unknown, session = "one") => ({ body, session: { label: session }, signal: new AbortController().signal } as RouteContext);
    const open = await routes["POST /api/configuration/open"]!.run(context({ kind: "app" })) as { id: string; revision: number };
    const patch = { appId: "fixture", environment: "production", secret: { mode: "set", value: "private-fixture-key" } };
    const edited = await routes["POST /api/configuration/edit"]!.run(context({ id: open.id, revision: open.revision, patch })) as { id: string; revision: number };
    expect(JSON.stringify(edited)).not.toContain("private-fixture-key");
    await expect(routes["POST /api/configuration/check"]!.run(context({ id: edited.id, revision: edited.revision, network: false, refresh: false }, "two"))).rejects.toThrow();
    const checkBody = { id: edited.id, revision: edited.revision, network: false, refresh: false };
    const pending = routes["POST /api/configuration/check"]!.run(context(checkBody));
    drafts.edit(open.id, "one", edited.revision, patch);
    resolveCheck({ protocol: "mixin-configuration", version: 1, success: true, summary: ["校验通过"] });
    await expect(pending).rejects.toThrow(); expect(drafts.read(open.id).validated).toBeUndefined();
    const pendingEnd = routes["POST /api/configuration/check"]!.run(context({ ...checkBody, revision: edited.revision + 1 }));
    drafts.end("one"); resolveCheck({ protocol: "mixin-configuration", version: 1, success: true, summary: ["校验通过"] });
    await expect(pendingEnd).rejects.toThrow();
  } finally { await f.cleanup(); }
});

test("校验进程的协议必须完整成功；秘密经 stdin，参数和环境不含凭据", async () => {
  const f = await tempFixture("configuration-query-");
  try {
    const secret = "private-fixture-key";
    const definition = { args: ["/opt/homebrew/bin/bun", "ops/core/launchd-supervisor.ts"], env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" }, directory: f.root };
    const macos = { platform: "darwin" as const, service: async () => ({ account: { uid: 480, gid: 480 }, definition }) };
    const run = async (host: QueryHost) => {
      const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
      const query = configurationQuery(f.root, async (command, args, options) => {
        calls.push({ command, args, env: options?.env });
        expect(JSON.stringify([command, args, options?.env])).not.toContain(secret);
        if (args[0] === "container") return { code: 0, stdout: JSON.stringify([{ Image: "sha256:" + "a".repeat(64), Config: { User: "1001:1001" }, Mounts: [dataMount(f.root)] }]), stderr: "", timedOut: false };
        expect(options?.input).toContain(secret);
        return { code: 0, stdout: JSON.stringify({ protocol: "mixin-configuration", version: 1, success: true, summary: ["通过"] }), stderr: "", timedOut: false };
      }, host);
      await expect(query("check", { secret })).resolves.toMatchObject({ success: true });
      return calls.at(-1)!;
    };
    const docker = await run(linux);
    expect(docker.args).toContain("--read-only");
    expect(docker.args).toContain(`${join(SOURCE_DIR, "ops")}:/app/ops:ro`);
    expect(docker.args).toContain(`${join(f.root, "data")}:/app/data:ro`);
    for (const name of ["pyproject.toml", "uv.lock", ".python-version"]) expect(docker.args).toContain(`type=bind,source=${join(SOURCE_DIR, name)},target=/app/${name},readonly`);
    expect(docker.args).not.toContain(`${join(f.root, "ops")}:/app/ops:ro`);
    expect((await run({ ...linux, platform: "win32" })).args[0]).toBe(join(SOURCE_DIR, "ops/config/configuration-check.ts"));
    // macOS: the service's Bun as the service account, through the identity switch; its PATH, its home, no sudo traces.
    const native = await run(macos);
    expect(native.command).toBe(process.execPath);
    expect(native.args).toEqual(["--no-env-file", join(SOURCE_DIR, "ops/core/macos-become.ts"), "480", "480", "--", "/opt/homebrew/bin/bun", "--no-env-file",
      join(SOURCE_DIR, "ops/config/configuration-check.ts"), "check", f.root]);
    expect(native.env).toMatchObject({ PATH: definition.env.PATH, HOME: join(f.root, "data/runtime/home"), LANG: "C.UTF-8" });
    expect(native.env?.SUDO_USER).toBeUndefined();
    await expect(configurationQuery(f.root, async () => { throw new Error("not reached"); }, { platform: "darwin", service: async () => null })("check", {}))
      .rejects.toThrow("请先完成部署");
    const refused = configurationQuery(f.root, async (_command, args) => {
      if (args[0] === "container") return { code: 0, stdout: JSON.stringify([{ Image: "sha256:" + "a".repeat(64), Config: { User: "1001:1001" }, Mounts: [dataMount(f.root)] }]), stderr: "", timedOut: false };
      return { code: 1, stdout: '{"protocol":"mixin-configuration","version":1,"success":true}', stderr: secret, timedOut: false };
    }, linux);
    await expect(refused("check", {})).rejects.toThrow("未完成");
  } finally { await f.cleanup(); }
});

test("拒绝原因：项目自己的中文原因脱敏后给页面，库和系统错误仍是通用句；超时单独说明", async () => {
  const f = await tempFixture("configuration-reasons-");
  try {
    const container = { code: 0, stdout: JSON.stringify([{ Image: "sha256:" + "a".repeat(64), Config: { User: "1001:1001" }, Mounts: [dataMount(f.root)] }]), stderr: "", timedOut: false };
    const failing = (stderr: string, timedOut = false) => configurationQuery(f.root, async (_command, args) => args[0] === "container" ? container : { code: 1, stdout: "", stderr, timedOut }, linux);
    const reason = async (run: Promise<unknown>) => { try { await run; } catch (error) { return error as { status: number; code: string; message: string }; } throw new Error("expected a refusal"); };
    expect(await reason(failing("bun warning\n应用 token 验证失败，请检查应用凭据、环境和网络；尚未写入配置\n")("check", {})))
      .toMatchObject({ status: 409, code: "input", message: "应用 token 验证失败，请检查应用凭据、环境和网络；尚未写入配置" });
    const masked = await reason(failing("校验失败 token=fixture-do-not-display 13800138000")("check", {}));
    expect(masked.message).toBe("校验失败 token=*** 138****8000；正式配置未修改");
    expect((await reason(failing("JSON Parse error: Unexpected identifier \"fixture-do-not-display\"")("check", {}))).message).toContain("配置校验未完成");
    expect(await reason(failing("", true)("check", {}))).toMatchObject({ status: 504, code: "timeout" });

    const drafts = new ConfigurationDrafts(f.root), context = (body: unknown) => ({ body, session: { label: "one" }, signal: new AbortController().signal } as RouteContext);
    let thrown: unknown = new SyntaxError("JSON Parse error: fixture-do-not-display");
    const routes = configurationRoutes(drafts, async () => { throw thrown; });
    const open = await routes["POST /api/configuration/open"]!.run(context({ kind: "relay" })) as { id: string; revision: number };
    const relay = { enabled: true, endpoint: "http://127.0.0.1:9000", region: "us-east-1", bucket: "fixture-bucket", prefix: "", forcePathStyle: false,
      maxBytes: 64 * 1024 * 1024, expireHours: 24, cleanupGraceMinutes: 10, accessKey: { mode: "set", value: "fixture-access" }, secret: { mode: "set", value: "fixture-do-not-display" }, token: { mode: "clear" } };
    const refused = await reason(routes["POST /api/configuration/edit"]!.run(context({ id: open.id, revision: open.revision, patch: relay })));
    expect(refused.message).toContain("IP / localhost 端点需要 forcePathStyle: true；正式配置未修改");
    const edited = await routes["POST /api/configuration/edit"]!.run(context({ id: open.id, revision: open.revision, patch: { ...relay, forcePathStyle: true } })) as { revision: number };
    const check = () => reason(routes["POST /api/configuration/check"]!.run(context({ id: open.id, revision: edited.revision, network: false, refresh: false })));
    for (const error of [thrown, Object.assign(new Error("EACCES: permission denied, open 'fixture-do-not-display' 拒绝"), { code: "EACCES" })]) {
      thrown = error;
      const message = (await check()).message;
      expect(message).toContain("配置请求未完成"); expect(message).not.toContain("fixture-do-not-display");
    }
    expect((await reason(routes["POST /api/configuration/edit"]!.run(context({ id: open.id, revision: 0, patch: relay })))).message).toBe("草稿已变化，请重新读取；正式配置未修改");
  } finally { await f.cleanup(); }
});
