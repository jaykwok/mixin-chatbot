// Bounded revision chains (src/durable/checkpoint.ts): every bot document uses the shared policy; a base every
// interval-th change gives exactly the values of a store that never writes one, at every step and after reopening;
// chains left by an older release beyond the legacy limit keep receiving deltas, shorter ones are compacted by their
// next change.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, defineDoc } from "@earendil-works/pi-durable";
import { CHECKPOINT_INTERVAL, checkpointDue, checkpointPolicy } from "../../src/durable/checkpoint.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { BOT_DOCUMENTS } from "../helpers/checkpoint-policy.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-checkpoint-");
afterAll(() => fixture.cleanup());
let counter = 0;
const nextPath = () => join(fixture.root, `db-${++counter}`, "durable.sqlite");

/** Stored revisions of the documents of one kind (kinds are stored JSON-encoded). */
function chain(path: string, kind: string): { revisions: number; bases: number } {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query(`SELECT count(*) AS revisions, coalesce(sum(r.kind = 'base'), 0) AS bases FROM document_revisions r
      JOIN documents d ON d.id = r.document_id WHERE d.kind = ?`).get(JSON.stringify(kind)) as { revisions: number; bases: number };
    return row;
  } finally { db.close(); }
}

test("every bot document uses the shared policy", () => {
  expect(BOT_DOCUMENTS.map(definition => definition.kind).sort()).toEqual([
    "mixin.controls", "mixin.inbox", "mixin.member", "mixin.member-identity", "mixin.member-records", "mixin.receipts",
    "mixin.reclamation-item", "mixin.reclamation-queue", "mixin.results", "mixin.space",
  ]);
  for (const definition of BOT_DOCUMENTS) expect(definition.checkpointWhen === checkpointDue).toBe(true);
});

test("the policy: a base for the 64th revision of a chain", () => {
  const due = (deltasSinceBase: number) => checkpointDue({}, [], { deltasSinceBase });
  expect(CHECKPOINT_INTERVAL).toBe(64);
  expect([0, 1, 62].map(due)).toEqual([false, false, false]);
  expect([63, 64, 1_024, 440_000].map(due)).toEqual([true, true, true, true]);
  expect(() => checkpointPolicy({ interval: 0 })).toThrow();
});

// A small deterministic generator (mulberry32): a failure names its seed.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Item = { at: number; text?: string; flags?: boolean[] };
type Value = { map: Record<string, Item>; list: Item[]; n: number; note?: string; nested: { epoch: number; pending: Item[] } };
const initial = (): Value => ({ map: {}, list: [], n: 0, nested: { epoch: 0, pending: [] } });
const Never = defineDoc<Value>({ kind: "prop.never", version: 1, checkpointWhen: () => false, scope: "session", initial });
/** The same document under the policy for `interval`. */
const policyDoc = (interval: number) =>
  defineDoc<Value>({ kind: "prop.policy", version: 1, checkpointWhen: checkpointPolicy({ interval }), scope: "session", initial });

/** The same random change on both documents: keys added, replaced and deleted, arrays grown, spliced and edited. */
function mutate(next: () => number, values: Value[], step: number): void {
  const op = Math.floor(next() * 9);
  const key = `k${Math.floor(next() * 12)}`;
  const item: Item = next() < 0.5 ? { at: step } : { at: step, text: "文字".repeat(1 + Math.floor(next() * 3)), flags: [next() < 0.5] };
  const index = Math.floor(next() * 4);
  for (const value of values) {
    switch (op) {
      case 0: value.map[key] = structuredClone(item); break;
      case 1: delete value.map[key]; break;
      case 2: if (value.map[key]) value.map[key]!.at = step; break;
      case 3: value.list.push(structuredClone(item)); break;
      case 4: value.list.splice(index, 1); break;
      case 5: if (value.list[index]) value.list[index]!.text = `#${step}`; break;
      case 6: value.n += step; break;
      case 7: if (step % 2) value.note = `note ${step}`; else delete value.note; break;
      case 8: value.nested.epoch++; value.nested.pending = value.nested.pending.slice(-2).concat(structuredClone(item)); break;
    }
  }
}

for (const [interval, steps] of [[1, 40], [2, 40], [64, 150]] as const) {
  test(`a base every ${interval} change(s) reads exactly like a chain without bases, at every step and after reopening`, async () => {
    const Policy = policyDoc(interval), path = nextPath();
    const seed = 0x5eed + interval;
    const next = random(seed);
    let storage = await openGroupStorage(path);
    let session = createSession(storage);
    // The first commit creates both documents (a base); later ones store a delta only when the value changed.
    let previous = "", deltas = 0;
    try {
      for (let step = 1; step <= steps; step++) {
        await session.commit(async tx => { mutate(next, [await tx.doc(Never), await tx.doc(Policy)], step); }, context);
        const never = await session.snapshot(Never, context), policy = await session.snapshot(Policy, context);
        if (step > 1 && JSON.stringify(never) !== previous) deltas++;
        previous = JSON.stringify(never);
        if (JSON.stringify(policy) !== JSON.stringify(never)) throw new Error(`seed ${seed}, step ${step}: values differ`);
        const stored = chain(path, "prop.policy");
        // One base, then fewer deltas than the interval.
        expect(stored.bases).toBe(1);
        expect(stored.revisions).toBeLessThanOrEqual(interval);
      }
      expect(deltas).toBeGreaterThan(steps / 2);
      expect(chain(path, "prop.never")).toEqual({ revisions: 1 + deltas, bases: 1 });
      await session.close(context);
      await storage.close(context);
      storage = await openGroupStorage(path);
      session = createSession(storage);
      expect(JSON.stringify(await session.snapshot(Policy, context))).toBe(JSON.stringify(await session.snapshot(Never, context)));
    } finally {
      await session.close(context).catch(() => {});
      await storage.close(context).catch(() => {});
    }
  });
}
