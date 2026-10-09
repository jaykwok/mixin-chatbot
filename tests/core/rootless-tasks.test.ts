import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { RootlessTasks, type TaskDriver, type TaskStorage } from "../../src/core/rootless-tasks.ts";
import { RemovalPermit } from "../../src/core/reclamation.ts";
import { holdDirectory } from "../../src/core/held-directory.ts";
import { publishJson } from "../../scripts/migrations/lib/io.ts";
import { tempFixture } from "../helpers/temp.ts";

const image = "sha256:" + "a".repeat(64);
test("a different-device subtree cannot receive a removal permit", () => {
  expect(() => new RemovalPermit({ dev: 1n, ino: 2n }, { dev: 3n, ino: 4n })).toThrow("不同设备");
});
function syntheticDriver() {
  const containers = new Map<string, any>(), calls: string[][] = []; let index = 0;
  const driver: TaskDriver = { async run(args) {
    calls.push(args);
    if (args[0] === "info") return { exitCode: 0, output: JSON.stringify({ ID: "synthetic-daemon", SecurityOptions: ["name=rootless"] }) };
    if (args[0] === "image") return { exitCode: 0, output: JSON.stringify([{ Id: image, Os: "linux" }]) };
    if (args[0] === "create") {
      const values = (key: string) => args.flatMap((value, i) => value === key ? [args[i + 1]!] : []);
      const cid = String(++index).padStart(64, "0");
      containers.set(cid, { Id: cid, Name: values("--name")[0], Image: image, State: { Running: false }, Config: { Labels: Object.fromEntries(values("--label").map(value => value.split("="))) },
        HostConfig: { Privileged: false, PidMode: "", IpcMode: "private", NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] },
        Mounts: values("--mount").map(value => { const fields = value.split(","); return { Type: "bind", Source: fields.find(x => x.startsWith("src="))!.slice(4), Destination: fields.find(x => x.startsWith("dst="))!.slice(4), RW: !fields.includes("readonly") }; }),
      }); return { exitCode: 0, output: cid };
    }
    if (args[0] === "start") { const container = containers.get(args[2]!)!; await writeFile(join(container.Mounts.find((m: any) => m.RW).Source, "output"), "owned"); return { exitCode: 0, output: "complete" }; }
    const container = containers.get(args[2]!) ?? [...containers.values()].find(value => value.Name === args[2]);
    if (args[1] === "inspect") return { exitCode: container ? 0 : 1, output: container ? JSON.stringify([container]) : `Error response from daemon: No such container: ${args[2]}` };
    if (args[1] === "kill") container.State.Running = false;
    if (args[1] === "rm") containers.delete(args[2]!);
    return { exitCode: 0, output: "0" };
  } };
  return { driver, containers, calls };
}

async function savedReceipt(control: string, id: string) {
  return JSON.parse(JSON.parse(await readFile(join(control, "receipts", id + ".json"), "utf8")).payload);
}
function allocationStorage(overrides: Partial<TaskStorage> = {}): TaskStorage {
  return { holdDirectory, async saveReceipt(path, envelope, first) {
    if (first) await writeFile(path, JSON.stringify(envelope), { flag: "wx", mode: 0o600 });
    else await publishJson(path, envelope);
  }, ...overrides };
}

test.skipIf(process.platform !== "linux")("a completed first receipt write with lost acknowledgement enters failed allocation instead of a live allocator", async () => {
  const f = await tempFixture("rootless-first-receipt-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(), normal = allocationStorage(), failure = new Error("lost first receipt acknowledgement");
  const storage = allocationStorage({ async saveReceipt(path, envelope, first) {
    await normal.saveReceipt(path, envelope, first); if (first) throw failure;
  } });
  const tasks = new RootlessTasks(control, image, backend.driver, storage), reservation = tasks.reserve(temp);
  try {
    await expect(reservation.create()).rejects.toBe(failure);
    const receipt = await savedReceipt(control, reservation.id); expect(receipt.phase).toBe("allocation-failed"); expect(receipt.allocation.step).toBe("reserved");
    expect(await tasks.reclaim(reservation.id)).toMatchObject({ status: "deferred", reason: "allocation-entity-unconfirmed" });
    expect((await tasks.sweep(temp, Infinity, []))[0]).toMatchObject({ status: "deferred", reason: "allocation-entity-unconfirmed" });
    expect((await savedReceipt(control, reservation.id)).phase).toBe("allocation-failed");
    await expect(readdir(join(temp, ".isolated-work"))).rejects.toThrow("ENOENT");
    expect(backend.calls.some(args => args[0] === "create")).toBe(false);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("first receipt collision cannot overwrite an authenticated receipt belonging to another allocation", async () => {
  const f = await tempFixture("rootless-first-collision-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(); let original = "", laterSaves = 0;
  const failure = Object.assign(new Error("first receipt already exists"), { code: "EEXIST" });
  const storage = allocationStorage({ async saveReceipt(path, envelope, first) {
    if (!first) { laterSaves++; throw new Error("foreign receipt must not be updated"); }
    const receipt = JSON.parse(envelope.payload); receipt.nonce = "b".repeat(64);
    const manager = JSON.parse(await readFile(join(control, "manager.json"), "utf8")), payload = JSON.stringify(receipt);
    original = JSON.stringify({ payload, signature: createHmac("sha256", Buffer.from(manager.key, "hex")).update(payload).digest("hex") });
    await writeFile(path, original, { flag: "wx", mode: 0o600 }); throw failure;
  } });
  const tasks = new RootlessTasks(control, image, backend.driver, storage), reservation = tasks.reserve(temp);
  try {
    const error = await reservation.create().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(failure); expect(error.errors[0]).toBe(failure);
    expect(error.errors[1].message).toContain("不属于本次分配"); expect(laterSaves).toBe(0);
    expect(await readFile(join(control, "receipts", reservation.id + ".json"), "utf8")).toBe(original);
    await expect(readdir(join(temp, ".isolated-work"))).rejects.toThrow("ENOENT");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("an invalid partial first receipt is preserved with both write and confirmation errors", async () => {
  const f = await tempFixture("rootless-first-partial-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(), failure = new Error("partial first receipt write"); let laterSaves = 0;
  const storage = allocationStorage({ async saveReceipt(path, _envelope, first) {
    if (!first) { laterSaves++; throw new Error("partial ownership must not be assumed"); }
    await writeFile(path, "{", { flag: "wx", mode: 0o600 }); throw failure;
  } });
  const tasks = new RootlessTasks(control, image, backend.driver, storage), reservation = tasks.reserve(temp);
  try {
    const error = await reservation.create().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(failure); expect(error.errors[0]).toBe(failure); expect(error.errors[1]).toBeInstanceOf(SyntaxError);
    expect(laterSaves).toBe(0); expect(await readFile(join(control, "receipts", reservation.id + ".json"), "utf8")).toBe("{");
    await expect(readdir(join(temp, ".isolated-work"))).rejects.toThrow("ENOENT");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("failed initialization is shared concurrently, retried by the same backend, and successful checks stay cached", async () => {
  const f = await tempFixture("rootless-init-retry-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(); let offline = true, infoCalls = 0;
  let entered!: () => void, resume!: () => void;
  const arrival = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  const failure = new Error("initial daemon offline");
  const driver: TaskDriver = { async run(args, options) {
    if (args[0] === "info") {
      infoCalls++;
      if (offline) { entered(); await gate; throw failure; }
    }
    return backend.driver.run(args, options);
  } };
  const tasks = new RootlessTasks(control, image, driver);
  try {
    const first = tasks.create(temp), second = tasks.create(temp), failed = Promise.allSettled([first, second]);
    await arrival; expect(infoCalls).toBe(1); resume();
    const results = await failed;
    for (const result of results) { expect(result.status).toBe("rejected"); if (result.status === "rejected") expect(result.reason).toBe(failure); }
    expect(await readdir(join(control, "receipts"))).toEqual([]);
    const manager = await readFile(join(control, "manager.json"), "utf8");
    offline = false;
    const recovered = await Promise.all([tasks.create(temp), tasks.create(temp)]);
    expect(infoCalls).toBe(2); expect(await readFile(join(control, "manager.json"), "utf8")).toBe(manager);
    for (const task of recovered) { await task.seal(); expect((await tasks.reclaim(task.id)).status).toBe("removed"); }
    expect(infoCalls).toBe(2);
  } finally { resume(); await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("persistent initialization failures do not mark readiness or allocate a receipt", async () => {
  const f = await tempFixture("rootless-init-persistent-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  let infoCalls = 0;
  const driver: TaskDriver = { async run() { infoCalls++; return { exitCode: 1, output: "daemon remains offline" }; } };
  const tasks = new RootlessTasks(control, image, driver);
  try {
    for (let attempt = 0; attempt < 3; attempt++) await expect(tasks.create(temp)).rejects.toThrow("daemon remains offline");
    expect(infoCalls).toBe(3); expect(await readdir(join(control, "receipts"))).toEqual([]);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("initialization retry revalidates root, manager identity, daemon isolation and pinned image", async () => {
  const f = await tempFixture("rootless-init-security-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(); let offline = true, rootless = true, matchingImage = true, infoCalls = 0;
  const driver: TaskDriver = { async run(args, options) {
    if (args[0] === "info") {
      infoCalls++;
      if (offline) return { exitCode: 1, output: "daemon offline for security retry" };
      if (!rootless) return { exitCode: 0, output: JSON.stringify({ ID: "synthetic-daemon", SecurityOptions: [] }) };
    }
    if (args[0] === "image" && !matchingImage) return { exitCode: 0, output: JSON.stringify([{ Id: "sha256:" + "b".repeat(64), Os: "linux" }]) };
    return backend.driver.run(args, options);
  } };
  const tasks = new RootlessTasks(control, image, driver);
  try {
    await expect(tasks.create(temp)).rejects.toThrow("daemon offline"); offline = false;
    const managerPath = join(control, "manager.json"), original = await readFile(managerPath, "utf8");
    await writeFile(managerPath, JSON.stringify({ manager: "corrupt", key: "0".repeat(64) }));
    await expect(tasks.create(temp)).rejects.toThrow("管理身份损坏"); expect(infoCalls).toBe(1);
    await writeFile(managerPath, original); await chmod(control, 0o755);
    await expect(tasks.create(temp)).rejects.toThrow("0700"); expect(infoCalls).toBe(1); await chmod(control, 0o700);
    rootless = false; await expect(tasks.create(temp)).rejects.toThrow("rootless Docker");
    rootless = true; matchingImage = false; await expect(tasks.create(temp)).rejects.toThrow("镜像身份不匹配");
    matchingImage = true; const task = await tasks.create(temp); await task.seal(); expect((await tasks.reclaim(task.id)).status).toBe("removed");
    expect(infoCalls).toBe(4); expect(await readFile(managerPath, "utf8")).toBe(original);
  } finally { await chmod(control, 0o700); await f.cleanup(); }
});

for (const stage of ["parent-open", "entity-save", "marker-write", "work-created", "active-save"] as const) {
  test.skipIf(process.platform !== "linux")(`allocation failure at ${stage} records its state and permits only authenticated recovery by the live manager`, async () => {
    const f = await tempFixture("rootless-allocation-stage-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
    const backend = syntheticDriver(), normal = allocationStorage(); let inject = true;
    const failure = new Error("allocation fault: " + stage);
    const storage = allocationStorage({
      async saveReceipt(path, envelope, first) {
        const receipt = JSON.parse(envelope.payload);
        if (inject && (stage === "entity-save" && receipt.phase === "allocating" && receipt.allocation.step === "entity-registered" || stage === "active-save" && receipt.phase === "active")) { inject = false; throw failure; }
        await normal.saveReceipt(path, envelope, first);
      },
      async holdDirectory(base, names, create) {
        if (inject && stage === "parent-open" && names.length === 2) { inject = false; throw failure; }
        const held = await holdDirectory(base, names, create);
        return { identity: held.identity,
          use: action => held.use(async entries => {
            const value = await action(entries);
            if (inject && stage === "marker-write" && names.length === 2) { inject = false; throw failure; }
            return value;
          }),
          async release() {
            await held.release();
            if (inject && stage === "work-created" && names.at(-1) === "work") { inject = false; throw failure; }
          },
        };
      },
    });
    const tasks = new RootlessTasks(control, image, backend.driver, storage), reservation = tasks.reserve(temp);
    try {
      await expect(reservation.create()).rejects.toBe(failure);
      const receipt = await savedReceipt(control, reservation.id);
      expect(receipt.phase).toBe("allocation-failed"); expect(receipt.pid).toBe(process.pid);
      expect(receipt.containers).toEqual([]); expect(receipt.pendingNames).toEqual([]);
      expect(receipt.allocation.step).toBe(stage === "parent-open" ? "reserved" : stage === "work-created" ? "marker-written" : stage === "active-save" ? "work-created" : "entity-registered");
      const reclaimed = await tasks.reclaim(reservation.id, temp);
      if (stage === "parent-open" || stage === "entity-save") {
        expect(reclaimed).toMatchObject({ status: "deferred", reason: stage === "parent-open" ? "allocation-entity-unconfirmed" : "allocation-marker-unconfirmed" });
        expect((await savedReceipt(control, reservation.id)).phase).toBe("allocation-failed");
        const sweep = await tasks.sweep(temp, Infinity, []); expect(sweep).toHaveLength(1); expect(sweep[0]!.reason).toBe(reclaimed.reason);
      } else {
        expect(reclaimed.status).toBe("removed"); expect((await tasks.reclaim(reservation.id)).status).toBe("removed");
        await expect(readdir(dirname(reservation.path))).rejects.toThrow("ENOENT");
      }
      expect(backend.calls.some(args => args[0] === "create")).toBe(false);
    } finally { await f.cleanup(); }
  });
}

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("real marker EACCES preserves an unmarked failed allocation without task-owner-live deferral", async () => {
  const f = await tempFixture("rootless-allocation-eacces-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(), tasks = new RootlessTasks(control, image, backend.driver), reservation = tasks.reserve(temp), taskRoot = dirname(reservation.path);
  await mkdir(taskRoot, { recursive: true, mode: 0o700 }); await writeFile(join(taskRoot, "unproven"), "keep original bytes"); await chmod(taskRoot, 0o500);
  try {
    await expect(reservation.create()).rejects.toThrow("EACCES"); await chmod(taskRoot, 0o700);
    const receipt = await savedReceipt(control, reservation.id); expect(receipt.phase).toBe("allocation-failed"); expect(receipt.pid).toBe(process.pid);
    expect(await tasks.reclaim(reservation.id)).toMatchObject({ status: "deferred", reason: "allocation-marker-unconfirmed" });
    expect((await tasks.sweep(temp, Infinity, []))[0]).toMatchObject({ status: "deferred", reason: "allocation-marker-unconfirmed" });
    expect(await readFile(join(taskRoot, "unproven"), "utf8")).toBe("keep original bytes");
    expect((await savedReceipt(control, reservation.id)).phase).toBe("allocation-failed"); expect(await readdir(taskRoot)).toEqual(["unproven"]);
  } finally { await chmod(taskRoot, 0o700); await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("allocation and failure-checkpoint errors are aggregated and the same backend retries the checkpoint before reclaiming", async () => {
  const f = await tempFixture("rootless-allocation-record-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(), normal = allocationStorage(); let offline = true;
  const allocationError = new Error("allocation checkpoint offline"), recordError = new Error("failure checkpoint offline");
  const storage = allocationStorage({ async saveReceipt(path, envelope, first) {
    const receipt = JSON.parse(envelope.payload);
    if (offline && receipt.phase === "allocating" && receipt.allocation.step === "marker-written") throw allocationError;
    if (offline && receipt.phase === "allocation-failed") throw recordError;
    await normal.saveReceipt(path, envelope, first);
  } });
  const tasks = new RootlessTasks(control, image, backend.driver, storage), reservation = tasks.reserve(temp);
  try {
    const error = await reservation.create().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([allocationError, recordError]); expect(error.cause).toBe(allocationError);
    expect((await savedReceipt(control, reservation.id)).phase).toBe("allocating");
    await expect(tasks.reclaim(reservation.id)).rejects.toBe(recordError);
    expect(await readFile(join(dirname(reservation.path), ".manager-owner"), "utf8")).toBe((await savedReceipt(control, reservation.id)).nonce);
    offline = false; expect((await tasks.reclaim(reservation.id)).status).toBe("removed");
    expect((await new RootlessTasks(control, image, backend.driver).reclaim(reservation.id)).status).toBe("removed");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("in-progress allocation and a successfully delivered active task remain protected from reclamation", async () => {
  const f = await tempFixture("rootless-allocation-live-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(); let entered!: () => void, resume!: () => void;
  const arrival = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  const storage = allocationStorage({ async holdDirectory(base, names, create) {
    if (names.length === 2 && create) { entered(); await gate; }
    return holdDirectory(base, names, create);
  } });
  const tasks = new RootlessTasks(control, image, backend.driver, storage), reservation = tasks.reserve(temp);
  try {
    const allocating = reservation.create(); await arrival;
    expect((await savedReceipt(control, reservation.id)).phase).toBe("allocating");
    const separateManager = new RootlessTasks(control, image, backend.driver);
    expect(await separateManager.reclaim(reservation.id)).toMatchObject({ status: "deferred", reason: "task-allocation-live" });
    const sameManagerReclaim = tasks.reclaim(reservation.id); resume(); const task = await allocating;
    expect(await sameManagerReclaim).toMatchObject({ status: "deferred", reason: "task-owner-live" });
    expect((await tasks.describe(task.id, temp)).phase).toBe("active");
    await task.seal(); expect((await tasks.reclaim(task.id)).status).toBe("removed");
  } finally { resume(); await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("only signed manager results can be read while active; snapshots are read-only and results cannot launch workers", async () => {
  const f = await tempFixture("rootless-active-results-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(), tasks = new RootlessTasks(control, image, backend.driver);
  const producer = await tasks.reserve(temp, "results").create(), hidden = await tasks.create(temp), consumer = await tasks.create(temp);
  try {
    await writeFile(join(producer.path, "result"), "active result"); await writeFile(join(hidden.path, "private"), "private worker");
    await expect(producer.run({ command: "bun", args: [], cwd: producer.path, timeoutMs: 1000 })).rejects.toThrow("不能启动工作进程");
    expect(backend.calls.some(args => args[0] === "create")).toBe(false);
    await consumer.run({ command: "bun", args: [], cwd: consumer.path, timeoutMs: 1000 });
    const container = [...backend.containers.values()][0]!;
    const snapshot = container.Mounts.find((mount: any) => mount.Destination === temp);
    expect(snapshot.RW).toBe(false);
    expect(await readFile(join(snapshot.Source, ".isolated-work", producer.id, "work/result"), "utf8")).toBe("active result");
    await expect(readdir(join(snapshot.Source, ".isolated-work", hidden.id))).rejects.toThrow("ENOENT");
    expect((await tasks.reclaim(producer.id)).status).toBe("deferred");
    await writeFile(join(producer.path, "result"), "producer continues");
    expect(await readFile(join(snapshot.Source, ".isolated-work", producer.id, "work/result"), "utf8")).toBe("active result");
  } finally {
    for (const task of [consumer, producer, hidden]) { await task.seal(); await tasks.reclaim(task.id); }
    await f.cleanup();
  }
});

test.skipIf(process.platform !== "linux")("a create completed after failed sealing can be recovered by the same live manager", async () => {
  const f = await tempFixture("rootless-late-create-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(); let pending: string[] | undefined;
  const driver: TaskDriver = { async run(args, options) {
    if (args[0] === "create") { pending = args; throw new Error("create acknowledgement timed out before daemon completion"); }
    return backend.driver.run(args, options);
  } };
  const tasks = new RootlessTasks(control, image, driver), task = await tasks.create(temp);
  try {
    await expect(task.run({ command: "bun", args: [], cwd: task.path, timeoutMs: 1000 })).rejects.toThrow("acknowledgement timed out");
    await expect(task.seal()).rejects.toThrow("No such container");
    expect((await tasks.describe(task.id, temp)).phase).toBe("stopping");
    expect(pending).toBeDefined(); await backend.driver.run(pending!);
    const recovered = new RootlessTasks(control, image, backend.driver);
    expect((await recovered.reclaim(task.id)).status).toBe("removed");
    expect(backend.containers.size).toBe(0);
    expect((await recovered.reclaim(task.id)).status).toBe("removed");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("registered isolated task refuses live reclamation, seals writers and removes only its authenticated subtree", async () => {
  const f = await tempFixture("rootless-contract-");
  const temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(), tasks = new RootlessTasks(control, image, backend.driver), task = await tasks.create(temp);
  try {
    expect((await tasks.reclaim(task.id)).status).toBe("deferred");
    expect((await task.run({ command: "bun", args: ["-e", "0"], cwd: task.path, timeoutMs: 1000 })).exitCode).toBe(0);
    expect(await readFile(join(task.path, "output"), "utf8")).toBe("owned");
    await task.seal();
    await expect(task.run({ command: "bun", args: [], cwd: task.path, timeoutMs: 1000 })).rejects.toThrow("禁止新写者");
    expect((await tasks.reclaim(task.id)).status).toBe("removed");
    expect((await tasks.reclaim(task.id)).status).toBe("removed"); expect(backend.containers.size).toBe(0);
    await expect(readFile(join(task.path, "output"))).rejects.toThrow("ENOENT");
    const fresh = new RootlessTasks(control, image, backend.driver); expect((await fresh.reclaim(task.id)).status).toBe("removed");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("unacknowledged create, replaced entities and unexpected read-only mounts preserve their receipts", async () => {
  const f = await tempFixture("rootless-uncertain-"); const temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver();
  let loseReply = true;
  const driver: TaskDriver = { async run(args, options) {
    const result = await backend.driver.run(args, options);
    if (args[0] === "create" && loseReply) { loseReply = false; throw new Error("synthetic lost create reply"); }
    return result;
  } };
  const tasks = new RootlessTasks(control, image, driver), task = await tasks.create(temp);
  try {
    await expect(task.run({ command: "bun", args: [], cwd: task.path, timeoutMs: 1000 })).rejects.toThrow("lost create reply");
    expect(backend.containers.size).toBe(1);
    await task.seal(); expect((await tasks.reclaim(task.id)).status).toBe("removed"); expect(backend.containers.size).toBe(0);
    const other = await tasks.create(temp); await other.run({ command: "bun", args: [], cwd: other.path, timeoutMs: 1000 });
    const container = [...backend.containers.values()][0]!;
    container.Mounts.push({ Type: "bind", Source: control, Destination: "/journal", RW: false });
    await expect(other.seal()).rejects.toThrow("权限或挂载边界");
    expect(await readFile(join(other.path, "output"), "utf8")).toBe("owned");
    container.Mounts.pop(); await other.seal();
    await writeFile(join(other.path, "../.manager-owner"), "foreign");
    await expect(tasks.reclaim(other.id)).rejects.toThrow("实体登记不匹配");
    expect(await readFile(join(other.path, "output"), "utf8")).toBe("owned");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("reclaim restart requires a daemon acknowledgement and never treats connection failure as removed", async () => {
  const f = await tempFixture("rootless-reclaim-restart-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(); let lostReply = true, offline = false;
  const driver: TaskDriver = { async run(args, options) {
    if (offline && args[0] === "container" && args[1] === "inspect") return { exitCode: 1, output: "Cannot connect to the Docker daemon" };
    const result = await backend.driver.run(args, options);
    if (lostReply && args[0] === "container" && args[1] === "rm") { lostReply = false; throw new Error("synthetic lost rm acknowledgement"); }
    return result;
  } };
  const tasks = new RootlessTasks(control, image, driver), task = await tasks.create(temp);
  try {
    await mkdir(join(task.path, ".work")); await writeFile(join(task.path, ".work/private"), "owned");
    await task.run({ command: "bun", args: [], cwd: task.path, timeoutMs: 1000 });
    await expect(task.seal({ discardScratch: true })).rejects.toThrow("lost rm acknowledgement");
    expect(await readFile(join(task.path, ".work/private"), "utf8")).toBe("owned");
    offline = true;
    const recovered = new RootlessTasks(control, image, driver);
    await expect(recovered.reclaim(task.id)).rejects.toThrow("daemon 不可用");
    expect((await recovered.describe(task.id, temp)).phase).toBe("stopping");
    offline = false;
    expect((await recovered.reclaim(task.id)).status).toBe("removed");
    expect((await recovered.reclaim(task.id)).status).toBe("removed");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("lost start acknowledgement retires the CID before scratch deletion and preserves scratch until retirement is confirmed", async () => {
  const f = await tempFixture("rootless-late-start-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(); let unconfirmed = true, removed = false, privatePath = "", retiredBeforeScratch = false;
  const driver: TaskDriver = { async run(args, options) {
    if (args[0] === "start") throw new Error("lost start acknowledgement with daemon start pending");
    if (args[0] === "container" && args[1] === "rm") {
      expect(args).toContain("--force");
      expect(await readFile(privatePath, "utf8")).toBe("keep until retired"); retiredBeforeScratch = true;
    }
    const result = await backend.driver.run(args, options);
    if (args[0] === "container" && args[1] === "rm") removed = true;
    if (removed && unconfirmed && args[0] === "container" && args[1] === "inspect") return { exitCode: 1, output: "Cannot connect to the Docker daemon" };
    return result;
  } };
  const tasks = new RootlessTasks(control, image, driver), task = await tasks.create(temp);
  try {
    await mkdir(join(task.path, ".work")); privatePath = join(task.path, ".work/private"); await writeFile(privatePath, "keep until retired");
    await expect(task.run({ command: "bun", args: [], cwd: task.path, timeoutMs: 1000 })).rejects.toThrow("lost start acknowledgement");
    await expect(task.seal({ discardScratch: true })).rejects.toThrow("撤销未确认");
    expect(retiredBeforeScratch).toBe(true); expect(backend.containers.size).toBe(0);
    expect(await readFile(privatePath, "utf8")).toBe("keep until retired"); expect((await tasks.describe(task.id, temp)).phase).toBe("stopping");
    unconfirmed = false; await task.seal({ discardScratch: true });
    await expect(readFile(privatePath)).rejects.toThrow("ENOENT");
    expect((await tasks.reclaim(task.id)).status).toBe("removed");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("reclaiming recovery keeps its deletion checkpoint across daemon failure with an already absent subtree", async () => {
  const f = await tempFixture("rootless-reclaiming-checkpoint-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(); let offline = false;
  const driver: TaskDriver = { async run(args, options) {
    if (offline && args[0] === "container" && args[1] === "inspect") return { exitCode: 1, output: "Cannot connect to the Docker daemon" };
    return backend.driver.run(args, options);
  } };
  const tasks = new RootlessTasks(control, image, driver), task = await tasks.create(temp);
  try {
    await task.run({ command: "bun", args: [], cwd: task.path, timeoutMs: 1000 }); await task.seal();
    const path = join(control, "receipts", task.id + ".json"), saved = JSON.parse(await readFile(path, "utf8")), receipt = JSON.parse(saved.payload);
    const manager = JSON.parse(await readFile(join(control, "manager.json"), "utf8"));
    receipt.phase = "reclaiming"; const payload = JSON.stringify(receipt);
    await writeFile(path, JSON.stringify({ payload, signature: createHmac("sha256", Buffer.from(manager.key, "hex")).update(payload).digest("hex") }));
    // Simulate a crash after deleting our authenticated synthetic task, before the removed checkpoint.
    await rm(join(task.path, ".."), { recursive: true }); offline = true;
    const recovered = new RootlessTasks(control, image, driver);
    await expect(recovered.reclaim(task.id)).rejects.toThrow("daemon 不可用");
    expect((await recovered.describe(task.id, temp)).phase).toBe("reclaiming");
    offline = false; expect((await recovered.reclaim(task.id)).status).toBe("removed");
    expect((await recovered.reclaim(task.id)).status).toBe("removed");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("tampered recovery receipt cannot authorize a path, and namespace/mount changes stop reclamation", async () => {
  const f = await tempFixture("rootless-refusal-"); const temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const backend = syntheticDriver(), tasks = new RootlessTasks(control, image, backend.driver), task = await tasks.create(temp);
  try {
    await task.run({ command: "bun", args: [], cwd: task.path, timeoutMs: 1000 });
    const cid = [...backend.containers.keys()][0]!; backend.containers.get(cid).HostConfig.PidMode = "host";
    await expect(task.seal()).rejects.toThrow("权限或挂载边界"); expect(await readFile(join(task.path, "output"), "utf8")).toBe("owned");
    const path = join(control, "receipts", task.id + ".json"), saved = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...saved, payload: saved.payload.replace('"version":2', '"version":1') }));
    await expect(tasks.reclaim(task.id)).rejects.toThrow("签名无效"); expect(await readFile(join(task.path, "output"), "utf8")).toBe("owned");
    await expect(tasks.reclaim("../caller")).rejects.toThrow("ID 无效");
  } finally { await f.cleanup(); }
});
