// D1-R1-1: once the service learns that a lease is lost, another process may already own the data, so the service must
// not write again: no statistics, no Durable commit, no archive, no maintenance, no waiting for tasks. A normal shutdown
// still does all of that. Both run the real service entry point in its own process (tests/helpers/service-harness.ts) with synthetic
// data; the loss is a real takeover of the lease by this process, reported by the service's own heartbeat.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { GROUP_ROOT_LEASE } from "../../src/core/data-version.ts";
import { acquireGroupRootLease, acquireLease } from "../../src/core/maintenance.ts";
import { tempFixture } from "../helpers/temp.ts";

const harness = fileURLToPath(new URL("../helpers/service-harness.ts", import.meta.url));
const HEARTBEAT = "data/groups/group/workspace/tool-heartbeat.txt";
// Lease directories and logs are not data; the tool's heartbeat is checked on its own.
const NOT_DATA = ["logs", "gate.open", HEARTBEAT, "data/state/service.lock", `data/groups/${GROUP_ROOT_LEASE}`];
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * A SQLite database by content, every row of every table. Closing the last connection at process exit checkpoints the
 * WAL: committed pages move into the main file under SQLite's own locks, the content stays the same.
 */
function rows(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all().map((row) => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
}

/** Every file of the service's directory that holds data: relative path → sha256 of its bytes, or of its rows. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = relative(root, path).replaceAll("\\", "/");
      if (NOT_DATA.some((skip) => name === skip || name.startsWith(skip + "/")) || /\.sqlite-(wal|shm|journal)$/.test(name)) continue;
      if (entry.isDirectory()) walk(path);
      else files[name] = name.endsWith(".sqlite") ? "rows:" + sha256(rows(path)) : sha256(readFileSync(path));
    }
  };
  walk(root);
  return files;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function beats(root: string): number[] {
  return readFileSync(join(root, HEARTBEAT), "utf8").split("\n").filter(Boolean).map(Number);
}

async function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no result within ${timeoutMs} ms`)), timeoutMs); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

function startService(root: string) {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  void probe.stop(true);
  const child = Bun.spawn([process.execPath, harness], {
    cwd: root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups", BOT_HOST: "127.0.0.1", BOT_PORT: String(port) },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  let output = "";
  const decoder = new TextDecoder();
  const read = (async () => { for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true }); })();
  const stderr = new Response(child.stderr).text();
  const exited = child.exited.then(async (code) => ({ code, at: Date.now() }));
  let done = false;
  void exited.then(() => { done = true; });
  /** The first output line containing `text`. */
  async function line(text: string, timeoutMs: number): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const finished = done;
      if (finished) await read;
      const found = output.split("\n").find((candidate) => candidate.includes(text));
      if (found !== undefined) return found;
      if (finished || Date.now() > end) throw new Error(`service output has no "${text}":\n${output}\n${done ? await stderr : ""}`);
      await Bun.sleep(20);
    }
  }
  /** Everything the service printed, once it exited. */
  const transcript = async () => { await read; return output + (await stderr); };
  return { child, exited, line, transcript };
}

describe("service lease loss", () => {
  for (const lease of ["group root", "service"] as const) {
    test(`a known loss of the ${lease} lease ends the service at once: nothing more is written and the tool is reaped`, async () => {
      const fixture = await tempFixture("lease-loss-");
      const service = startService(fixture.root);
      let takeover: (() => Promise<void>) | undefined;
      try {
        const ready = JSON.parse((await service.line("SERVICE_READY=", 40_000)).split("SERVICE_READY=")[1]!) as { tool: number };
        const before = snapshot(fixture.root);
        // Idle at the gates: nothing changes on its own.
        await Bun.sleep(300);
        expect(snapshot(fixture.root)).toEqual(before);
        expect(before["data/groups/stats.sqlite"]).toBeDefined();
        expect(before["data/groups/group/durable.sqlite"]).toBeDefined();
        expect(alive(ready.tool)).toBe(true);
        // Another holder takes the lease over; the service's next heartbeat (every 5 s) reports the loss.
        if (lease === "group root") {
          rmSync(join(fixture.root, "data/groups", GROUP_ROOT_LEASE), { recursive: true, force: true });
          takeover = await acquireGroupRootLease("test", join(fixture.root, "data/groups"), { retries: 0 });
        } else {
          rmSync(join(fixture.root, "data/state/service.lock"), { recursive: true, force: true });
          takeover = await acquireLease("test", join(fixture.root, "data/state/service"), { retries: 0 });
        }
        await service.line("服务租约丢失", 15_000);
        // The callback has run: release the task, the maintenance and the archive, as if the service had carried on.
        writeFileSync(join(fixture.root, "gate.open"), "");
        const { code, at } = await within(service.exited, 10_000, "service exit after the loss");
        expect(code).toBe(1);
        await Bun.sleep(1500);
        // No statistics, no archive, no conversation or delivery change, no new file: as before the loss.
        expect(snapshot(fixture.root)).toEqual(before);
        // Its supervisor reaped the tool when the service's pipe closed: it no longer runs or writes.
        expect(alive(ready.tool)).toBe(false);
        const last = beats(fixture.root);
        await Bun.sleep(500);
        expect(beats(fixture.root)).toEqual(last);
        expect(last.at(-1)!).toBeLessThan(at + 2000);
      } finally {
        service.child.kill();
        await service.child.exited;
        await takeover?.();
        await fixture.cleanup();
      }
    }, 60_000);
  }

  test("a normal shutdown still records statistics, archives the instance file, reaps the tool and releases both leases", async () => {
    const fixture = await tempFixture("lease-shutdown-");
    const service = startService(fixture.root);
    try {
      const ready = JSON.parse((await service.line("SERVICE_READY=", 40_000)).split("SERVICE_READY=")[1]!) as { tool: number };
      expect(alive(ready.tool)).toBe(true);
      const instance = JSON.parse(readFileSync(join(fixture.root, "data/state/instance.json"), "utf8")) as { port: number; token: string };
      const response = await fetch(`http://127.0.0.1:${instance.port}/_admin/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${instance.token}` } });
      expect(response.status).toBe(200);
      await service.line("BLOCKED_ABORTED", 10_000);
      // Shutdown waits for the maintenance at its gate. The /clear waiting at the gate before its projection is not waited
      // for: the group's Harness closes under it, the control stays in the stream and runs again at the next start, and
      // the next projection counts what this one would have (src/durable/groups.ts closeAll).
      writeFileSync(join(fixture.root, "gate.open"), "");
      const { code, at } = await within(service.exited, 30_000, "normal shutdown");
      const transcript = await service.transcript();
      expect(code, transcript).toBe(0);
      expect(transcript).not.toContain("ERROR");
      const db = new Database(join(fixture.root, "data/groups/stats.sqlite"));
      try {
        const users = db.query("SELECT user_segment FROM sources").all().map((row) => (row as { user_segment: string }).user_segment);
        expect(users).toEqual(expect.arrayContaining(["archive"]));
      } finally { db.close(); }
      const archived = readdirSync(join(fixture.root, "backup/rm"));
      expect(archived.some((name) => name.endsWith("-instance.json"))).toBe(true);
      expect(existsSync(join(fixture.root, "data/groups", GROUP_ROOT_LEASE))).toBe(false);
      expect(existsSync(join(fixture.root, "data/state/service.lock"))).toBe(false);
      expect(alive(ready.tool)).toBe(false);
      const last = beats(fixture.root);
      await Bun.sleep(500);
      expect(beats(fixture.root)).toEqual(last);
      expect(last.at(-1)!).toBeLessThan(at);
    } finally {
      service.child.kill();
      await service.child.exited;
      await fixture.cleanup();
    }
  }, 60_000);
});
