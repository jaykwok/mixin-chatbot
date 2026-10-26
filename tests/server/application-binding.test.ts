// F1 (docs/dev/app-bot-final-audit-20261025.md): the whole data directory belongs to one application. The service started
// on data registered to another AppID or platform environment, or whose record lacks the binding, refuses before the
// member directory, any space or any task opens: the fake platform receives no request and the data stays as it was.
// A rotated AppSecret of the same application starts normally. Runs the real entry point in its own process.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { applicationBinding, VERSION_FILE } from "../../src/core/data-version.ts";
import { appLayout, DIRECT_SCOPE, groupScope, spaceDatabase, type Scope } from "../../src/core/layout.ts";
import { APP_VERSION, DATA_VERSION } from "../../src/core/version.ts";
import { claimSpace, memberConversation } from "../../src/durable/identity.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { openState } from "../../src/core/state.ts";
import { IdentityDirectory } from "../../src/integrations/open-platform/identity-directory.ts";
import type { AppBotConfig } from "../../src/integrations/open-platform/config.ts";
import { fauxModels, harnessOptions } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const harness = fileURLToPath(new URL("../helpers/binding-harness.ts", import.meta.url));
const APP_A: AppBotConfig = { environment: "production", appId: "application-a", appSecret: "secret-of-application-a" };
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function rows(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
}
/** Every data file except logs and leases: path → digest of bytes, or of rows for databases. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), name = relative(root, path).replaceAll("\\", "/");
      if (name === "logs" || name.endsWith(".lock") || name.includes("/service") || /\.sqlite-(wal|shm|journal)$/.test(name)) continue;
      if (entry.isDirectory()) walk(path);
      else files[name] = name.endsWith(".sqlite") ? "rows:" + sha256(rows(path)) : sha256(readFileSync(path));
    }
  };
  walk(root);
  return files;
}

/** A project deployed for application A, with a direct and a group conversation and a bound member directory. */
async function deployedProject(root: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, "data/config"), { recursive: true });
  await mkdir(join(root, "data/runtime/pi"), { recursive: true });
  await mkdir(join(root, "data/state"), { recursive: true });
  await writeFile(join(root, "data/config/models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test-only", models: [{
      id: "fake", name: "fake", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  await writeFile(join(root, "data/runtime/pi/settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake" }));
  await writeFile(join(root, "data/state", VERSION_FILE), JSON.stringify(record));
  const state = openState(join(root, "data/state/agent.sqlite"));
  try { new IdentityDirectory(state, applicationBinding(APP_A)); } finally { state.close(); }
  const { models, model } = fauxModels();
  const layout = appLayout(join(root, "data"));
  for (const scope of [DIRECT_SCOPE, groupScope("100")] as Scope[]) {
    const path = spaceDatabase(layout, scope);
    await mkdir(join(path, ".."), { recursive: true });
    const h = await Harness.open(await openGroupStorage(path), harnessOptions(models)(), context);
    try {
      await claimSpace(h, scope, context);
      expect((await memberConversation(h, scope, "13800000001", { model }, context)).created).toBe(true);
    } finally { await h.close(context); }
  }
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  try { return probe.port!; } finally { void probe.stop(true); }
}

async function start(root: string, timeoutMs = 60_000) {
  const child = Bun.spawn([process.execPath, harness], { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, BOT_PORT: String(freePort()), BOT_HOST: "127.0.0.1" } });
  let out = "";
  const reader = (async () => { for await (const chunk of child.stdout) out += new TextDecoder().decode(chunk); })();
  const err = new Response(child.stderr).text();
  const end = Date.now() + timeoutMs;
  while (!out.includes("SERVICE_READY") && child.exitCode === null && Date.now() < end) await Bun.sleep(20);
  const ready = out.includes("SERVICE_READY");
  if (ready || child.exitCode === null) child.kill();
  const code = await child.exited;
  await reader;
  const text = out + await err + (existsSync(join(root, "logs")) ? readdirSync(join(root, "logs"), { recursive: true })
    .filter(name => String(name).endsWith(".log")).map(name => readFileSync(join(root, "logs", String(name)), "utf8")).join("\n") : "");
  return { ready, code, text, requests: Number(/PLATFORM_REQUESTS=(\d+)/.exec(out)?.[1] ?? NaN) };
}

const deployed = (application: unknown) => ({ dataVersion: DATA_VERSION, appVersion: APP_VERSION, build: "", transaction: "deploy-binding", application });

describe("application binding at service start", () => {
  for (const [name, config, record, message] of [
    ["another AppID", { ...APP_A, appId: "application-b" }, deployed(applicationBinding(APP_A)), "数据目录登记的应用或平台环境与 data/config/app-bot.json 不一致"],
    ["another platform environment", { ...APP_A, environment: "staging" }, deployed(applicationBinding(APP_A)), "数据目录登记的应用或平台环境与 data/config/app-bot.json 不一致"],
    ["a record without the binding", APP_A, { ...deployed(undefined), application: undefined }, "版本标记没有应用绑定"],
    ["a damaged binding", APP_A, deployed("not-a-digest"), "版本标记没有应用绑定"],
  ] as const)
    test(`${name}: refused before any space or task opens; no platform request; data unchanged`, async () => {
      const f = await tempFixture("binding-refused-");
      try {
        await deployedProject(f.root, record);
        await writeFile(join(f.root, "data/config/app-bot.json"), JSON.stringify(config));
        const before = snapshot(join(f.root, "data"));
        const result = await start(f.root);
        expect(result.ready, result.text).toBe(false);
        expect(result.code).toBe(1);
        expect(result.text).toContain(message);
        expect(result.requests).toBe(0);
        expect(snapshot(join(f.root, "data"))).toEqual(before);
      } finally { await f.cleanup(); }
    }, 90_000);

  test("a rotated AppSecret of the same application starts normally", async () => {
    const f = await tempFixture("binding-secret-");
    try {
      await deployedProject(f.root, deployed(applicationBinding(APP_A)));
      await writeFile(join(f.root, "data/config/app-bot.json"), JSON.stringify({ ...APP_A, appSecret: "rotated-secret-of-application-a" }));
      const result = await start(f.root);
      expect(result.ready, result.text).toBe(true);
      expect(result.requests).toBeGreaterThan(0);
    } finally { await f.cleanup(); }
  }, 90_000);
});
