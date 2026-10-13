import { spyOn } from "bun:test";
import { RootlessTasks } from "../../src/core/rootless-tasks.ts";
import * as runtime from "../../src/core/task-backend.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { handoffResults, ReclamationQueues } from "../../src/durable/results/queue.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import assert from "node:assert/strict";

/** Real result receipts and filesystem operations; Docker discovery is synthetic and cannot start a worker. */
export function stubResultsBackend(root: string) {
  const image = "sha256:" + "a".repeat(64);
  const backend = new RootlessTasks(root, image, { async run(args) {
    if (args[0] === "info") return { exitCode: 0, output: JSON.stringify({ ID: "results-fixture", SecurityOptions: ["name=rootless"] }) };
    if (args[0] === "image") return { exitCode: 0, output: JSON.stringify([{ Id: image, Os: "linux" }]) };
    throw new Error("Result fixture cannot run Docker: " + args.join(" "));
  } });
  const spy = spyOn(runtime, "configuredRootlessTasks").mockReturnValue(backend);
  return { backend, restore: () => spy.mockRestore() };
}

/** Cross the actual admission limit, keep a protected owner, and release space through the durable queue. */
export async function handoffFullResults(harness: Harness) {
  const names = Array.from({ length: 4095 }, (_, i) => `${100000 + i}-old`);
  await harness.commit(async tx => {
    const calls = (await tx.doc(ResultsDoc)).calls;
    for (const name of names) calls[name] = { phone: "old-member", createdAt: 1 };
    calls["999999-protected"] = { phone: "protected-member", createdAt: 1 };
  }, context);
  assert.equal(Object.keys((await harness.snapshot(ResultsDoc, context))!.calls).length, 4096);
  for (let i = 0; i < names.length; i += 128) await harness.commit(tx => handoffResults(tx, "old-member", names.slice(i, i + 128), 2), context);
  assert.equal((await harness.snapshot(ReclamationQueues, "old-member", context))!.count, 4095);
  assert.deepEqual(Object.keys((await harness.snapshot(ResultsDoc, context))!.calls), ["999999-protected"]);
}
