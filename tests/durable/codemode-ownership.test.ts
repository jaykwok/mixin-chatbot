// Result ownership of a codemode call that reruns after restarts under rootless isolation, where each attempt reserves
// its own isolated task: the ownership record, the run's output directory and the result name the same task at every
// interrupt point, the tasks of earlier attempts are left to reclamation, and /clear, reference protection and
// reclamation act on the right task. Real Harness, SQLite, official sandbox, held directories and ownership documents;
// only the rootless backend is a fixture (fresh UUID and `.isolated-work/<id>/work` per reservation, as
// RootlessTasks.reserve, with in-memory receipts); on Linux the three-attempt test runs with the real manager's receipts
// too.
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation, defineExtension, type JsonObject, type TaskDocToken, type ToolExecutionApi, type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as taskBackend from "../../src/core/task-backend.ts";
import type { ReferenceText } from "../../src/core/reference-text.ts";
import type { DirectoryRemoval } from "../../src/core/held-directory.ts";
import { codemodeExtension } from "../../src/durable/codemode/index.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { ResultMaintenance } from "../../src/durable/results/maintenance.ts";
import { registerResult, requestMemberExpiry, ResultsDoc } from "../../src/durable/results/ownership.ts";
import { referencedResults, resultReferences } from "../../src/durable/results/references.ts";
import { memberPlaces } from "../../src/durable/tools.ts";
import { fauxModels, type GroupHarness, openGroupHarness } from "../helpers/durable.ts";
import { appLayout, groupScope } from "../../src/core/layout.ts";
import { stubResultsBackend } from "../helpers/results-backend.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf } from "../helpers/layout.ts";

const fixture = await tempFixture("durable-codemode-ownership-");
afterAll(() => fixture.cleanup());
const GROUP = "group-a";
const PHONE = "+8613800000001";
const OUTPUT = 100_000;

/** As the reference text holds paths (src/durable/results/references.ts). */
const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

/** The rootless backend's result tasks, in memory: reservations, receipts by ID, reclamations. */
function rootlessFixture() {
  const allocated: string[] = [];
  const reclaimed: string[] = [];
  const receipts = new Map<string, { path: string; temp: string; name: string; createdAt: number; removed?: true }>();
  const reclaim = async (id: string): Promise<DirectoryRemoval> => {
    const receipt = receipts.get(id)!;
    await rm(dirname(receipt.path), { recursive: true, force: true });
    receipt.removed = true;
    reclaimed.push(id);
    return { name: id, status: "removed" };
  };
  const backend = {
    reserve(tempDir: string, _role: string, name: string) {
      const id = randomUUID(), path = join(tempDir, ".isolated-work", id, "work");
      return {
        id, path,
        async create() {
          allocated.push(id);
          receipts.set(id, { path, temp: tempDir, name, createdAt: Date.now() });
          await mkdir(path, { recursive: true });
          return { id, path, seal: async () => {} };
        },
      };
    },
    async describe(id: string) {
      const receipt = receipts.get(id)!;
      return { path: receipt.path, createdAt: receipt.createdAt, phase: receipt.removed ? "removed" : "active" };
    },
    reclaim,
    // As RootlessTasks.sweep: a referenced task stays; a result task goes only once its owner settled it (no record
    // claims it).
    async sweep(tempDir: string, before: number, references: ReferenceText, _excluded: ReadonlySet<string>,
      settled?: (id: string, name: string) => Promise<boolean>) {
      const results: DirectoryRemoval[] = [];
      for (const [id, receipt] of receipts) {
        if (receipt.removed || receipt.temp !== tempDir || receipt.createdAt >= before) continue;
        if (references.includes(fold(join(tempDir, ".isolated-work", id)), fold(join(tempDir, ".isolated-work") + sep))) continue;
        if (!settled || !await settled(id, receipt.name)) continue;
        results.push(await reclaim(id));
      }
      return results;
    },
  };
  return { backend, allocated, reclaimed, receipts };
}

let rootless: ReturnType<typeof rootlessFixture>;
let restore: (() => void) | undefined;
beforeEach(() => {
  rootless = rootlessFixture();
  const spy = spyOn(taskBackend, "configuredRootlessTasks").mockReturnValue(rootless.backend as never);
  restore = () => { spy.mockRestore(); restore = undefined; };
});
afterEach(() => { restore?.(); restore = undefined; });

type Point = "registered" | "written" | "decided";
/**
 * Where the next attempt stops until the Harness closes: after the commit that registers the result's ownership, after
 * the result file was written (before the outcome commit), or after the outcome commit.
 */
const pause: { at?: Point; reached?: PromiseWithResolvers<void>; written?: boolean; runDoc?: TaskDocToken<JsonObject>; taskId?: number } = {};
const pausing = defineExtension({
  name: "fixture.pause",
  wraps: [{
    tool: "codemode",
    wrap: (tool: ToolRegistration) => ({
      ...tool,
      execute: (args: unknown, api: ToolExecutionApi, ctx: typeof context) => {
        const hold = async () => {
          delete pause.at;
          pause.reached!.resolve();
          await new Promise<void>((resolve) => ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
          ctx.abortSignal?.throwIfAborted();
        };
        return tool.execute(args as never, new Proxy(api, {
          get(target, property) {
            if (property === "commit") {
              return async (change: (tx: unknown) => unknown, callContext: typeof context) => {
                if (pause.at === "written" && pause.written) {
                  pause.written = false;
                  await hold();
                }
                let registers = false;
                const value = await target.commit((tx) => change(new Proxy(tx, {
                  get(inner, key) {
                    if (key === "doc") {
                      return (token: TaskDocToken<JsonObject> & { definition?: { kind?: string } }, ...rest: unknown[]) => {
                        if (token.definition?.kind === ResultsDoc.definition.kind) registers = true;
                        if (token.definition?.kind === "pi.codemode.run") { pause.runDoc = token; pause.taskId = target.taskId as number; }
                        return (inner.doc as (...each: unknown[]) => unknown).call(inner, token, ...rest);
                      };
                    }
                    const each = Reflect.get(inner, key, inner);
                    return typeof each === "function" ? each.bind(inner) : each;
                  },
                })) as never, callContext);
                if (registers && pause.at === "registered") await hold();
                if (registers && pause.at === "written") pause.written = true;
                if (pause.at === "decided" && typeof value === "object" && value !== null && "output" in value) await hold();
                return value;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }), ctx);
      },
    }),
  }],
});

type Run = {
  group: GroupHarness; conversation: Conversation; tempDir: string; name: string;
  result: { details?: { fullOutputPath?: string } }; outputDirs: (string | undefined)[];
};

let databases = 0;
/** A codemode call writing a full output file, stopped at each of `points` in turn (a restart after each). */
async function run(points: Point[]): Promise<Run> {
  const { models, faux, model } = fauxModels();
  const root = join(fixture.root, `run-${++databases}`);
  const members = { layout: appLayout(join(root, "data")), scope: groupScope(GROUP) };
  const open = () => openGroupHarness(join(root, "db.sqlite"), models, { extensions: [pausing, codemodeExtension({ members, tools: [] })] });
  let group = await open();
  const { conversation } = await memberConversation(group.harness, scopeOf(GROUP), PHONE, { model }, context);
  const id = "cm-files";
  faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: `text("x".repeat(${OUTPUT}));` }, { id })], { stopReason: "toolUse" })]);
  const outputDirs: (string | undefined)[] = [];
  for (const [index, point] of points.entries()) {
    pause.at = point;
    pause.written = false;
    pause.reached = Promise.withResolvers<void>();
    if (index === 0) await conversation.submit({ type: "input", content: "运行脚本" }, context);
    await pause.reached.promise;
    // What the run document records at the stop.
    outputDirs.push((await group.harness.snapshot(pause.runDoc!, pause.taskId as never, context) as { outputDir?: string } | undefined)?.outputDir);
    await group.close();
    group = await open();
    group.harness.resume();
  }
  faux.setResponses([fauxAssistantMessage("好的")]);
  const again = (await group.harness.conversation(conversation.id, context))!;
  await again.waitForIdle(context);
  const entry = (await again.entries({}, 1000, undefined, context)).items
    .find((each) => each.kind === "pi.tool-result" && (each.model?.[0] as { toolCallId?: string })?.toolCallId === id);
  const result = entry?.model?.[0] as Run["result"];
  const tempDir = memberPlaces(members, members.scope, PHONE).tempDir;
  return { group, conversation: again, tempDir, name: Object.keys((await group.harness.snapshot(ResultsDoc, context))!.calls)[0]!, result, outputDirs };
}

const workOf = (tempDir: string, task: string) => join(tempDir, ".isolated-work", task, "work");

/** The record, the result's full output path and its file name one task, the last one allocated; it is referenced. */
async function expectOwned({ group, tempDir, name, result }: Run, task: string) {
  const record = (await group.harness.snapshot(ResultsDoc, context))!.calls[name]!;
  expect(record.isolatedTask).toBe(task);
  const path = result.details!.fullOutputPath!;
  expect(dirname(path)).toBe(workOf(tempDir, task));
  expect((await readFile(path, "utf8")).length).toBe(OUTPUT);
  expect([...referencedResults(tempDir, [name], resultReferences([result]), new Map([[name, task]]))]).toEqual([name]);
}

for (const point of ["registered", "written"] as const) {
  test(`stopped ${point === "registered" ? "after the ownership was registered" : "after the file was written, before the outcome"}: the rerun's task owns the result`, async () => {
    const ran = await run([point]);
    try {
      expect(rootless.allocated).toHaveLength(2);
      await expectOwned(ran, rootless.allocated[1]!);
      // The earlier attempt's directory was recorded when it stopped.
      expect(ran.outputDirs).toEqual([workOf(ran.tempDir, rootless.allocated[0]!)]);
    } finally { await ran.group.close(); }
  }, 60_000);
}

test("stopped after the outcome was stored: the rerun returns it, and the first task keeps owning it", async () => {
  const ran = await run(["decided"]);
  try {
    expect(rootless.allocated).toHaveLength(1);
    await expectOwned(ran, rootless.allocated[0]!);
  } finally { await ran.group.close(); }
}, 60_000);

// "manager": the real manager with result receipts on disk (Linux), Docker discovery synthetic (no worker can start).
test.each(process.platform === "linux" ? ["in-memory", "manager"] : ["in-memory"])("three attempts (%s receipts): the record and the run document follow each task; /clear, references and reclamation act on the right ones", async (receipts) => {
  const real = receipts === "manager" ? (restore?.(), stubResultsBackend(join(fixture.root, `control-${databases + 1}`))) : undefined;
  const ran = await run(["registered", "written"]);
  const { group, tempDir, name, result } = ran;
  const exists = (task: string) => existsSync(join(tempDir, ".isolated-work", task));
  try {
    const record = (await group.harness.snapshot(ResultsDoc, context))!.calls[name]!;
    const [first, second] = ran.outputDirs.map((dir) => basename(dirname(dir!)));
    const third = record.isolatedTask!;
    expect((await readdir(join(tempDir, ".isolated-work"))).toSorted()).toEqual([first!, second!, third].toSorted());
    if (real === undefined) expect(rootless.allocated).toEqual([first!, second!, third]);
    await expectOwned(ran, third);
    // At the second stop the run document recorded the second attempt's directory, not the first one's.
    expect(ran.outputDirs).toEqual([workOf(tempDir, first!), workOf(tempDir, second!)]);

    const warnings: string[] = [];
    const maintenance = new ResultMaintenance({ context, signal: new AbortController().signal, warn: (line) => warnings.push(line) });
    // /clear while the result is still referenced: the earlier tasks, claimed by no record, are reclaimed; the result's
    // task is kept, its record due.
    await group.harness.commit((tx) => requestMemberExpiry(tx, PHONE), context);
    await Bun.sleep(5);
    await maintenance.member(group.harness, PHONE, tempDir, Date.now(), resultReferences([result]));
    expect([exists(first!), exists(second!), exists(third)]).toEqual([false, false, true]);
    expect((await readFile(result.details!.fullOutputPath!, "utf8")).length).toBe(OUTPUT);
    const due = (await group.harness.snapshot(ResultsDoc, context))!.calls[name]!;
    expect(due).toMatchObject({ isolatedTask: third, phone: PHONE });
    expect(due.expiryRequestedAt).toBeNumber();
    expect(due.expiredAt).toBeUndefined();

    // No longer referenced: the result's task goes too, and its record becomes an expired receipt.
    await maintenance.member(group.harness, PHONE, tempDir, Date.now(), resultReferences([]));
    expect(exists(third)).toBe(false);
    expect((await group.harness.snapshot(ResultsDoc, context))!.calls[name]!.expiredAt).toBeNumber();
    expect(warnings).toEqual([]);
  } finally { real?.restore(); await group.close(); }
}, 90_000);

test("a record is moved only between isolated tasks of the same member", async () => {
  const { models } = fauxModels();
  const group = await openGroupHarness(join(fixture.root, "records.sqlite"), models, {});
  try {
    const register = (name: string, phone: string, task?: string) => group.harness.commit((tx) => registerResult(tx, name, phone, task), context);
    const record = async (name: string) => (await group.harness.snapshot(ResultsDoc, context))!.calls[name];
    const [a, b] = [randomUUID(), randomUUID()];
    await register("1-cm", PHONE, a);
    const registered = await record("1-cm");
    await register("1-cm", PHONE, a);
    expect(await record("1-cm")).toEqual(registered);
    await expect(register("1-cm", "+8613800000002", b)).rejects.toThrow("结果归属记录属于另一成员");
    await group.harness.commit((tx) => requestMemberExpiry(tx, PHONE), context);
    await register("1-cm", PHONE, b);
    expect(await record("1-cm")).toMatchObject({ phone: PHONE, isolatedTask: b, expiryRequestedAt: expect.any(Number) });
    await register("2-cm", PHONE);
    await expect(register("2-cm", PHONE, a)).rejects.toThrow("结果目录已登记为共享目录");
    expect((await record("2-cm"))!.isolatedTask).toBeUndefined();
  } finally { await group.close(); }
});
