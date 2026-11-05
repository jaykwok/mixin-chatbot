// Synthetic conversation databases whose bot documents carry revision chains like an older release left them (never a
// base), for the revision cleanup's own tests and the real Docker upgrade. Only made-up values; the phone is a fixture.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, defineDoc, type Tx } from "@earendil-works/pi-durable";
import { IdentityDoc, MemberDirectory, SpaceDoc } from "../../src/durable/identity.ts";
import { ControlsDoc, InboxDoc } from "../../src/durable/inbox.ts";
import { documentValue } from "../../src/durable/read/queries.ts";
import { MemberRecordsDoc, ReceiptsDoc } from "../../src/durable/records.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { ReclamationItems, ReclamationQueues } from "../../src/durable/results/queue.ts";
import { canonical } from "../../src/durable/revision-cleanup/documents.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { NEVER, useCheckpointPolicy } from "./checkpoint-policy.ts";

export const PHONE = "13800000001";

type Any = Record<string, any>;
/** A document of another kind, which the cleanup leaves alone. */
export const Other = defineDoc<{ n: number }>({ kind: "probe.other", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ n: 0 }) });

/** One change to every bot document (and to another kind's document), shaped like the real ones. */
export async function change(tx: Tx, conversation: number, i: number): Promise<void> {
  const doc = (token: unknown, ...args: unknown[]) => (tx.doc as unknown as (token: unknown, ...args: unknown[]) => Promise<Any>)(token, ...args);
  (await doc(SpaceDoc)).generation = `generation-${i}`;
  (await doc(MemberDirectory, PHONE, { conversationId: conversation, createdAt: 0 })).createdAt = i;
  (await doc(IdentityDoc, conversation)).phone = i % 2 ? PHONE : "";
  const inbox = await doc(InboxDoc, conversation);
  inbox.items.push({ requestId: `r${i}`, content: `消息 ${i}：${"文字".repeat(i % 5)}` });
  if (inbox.items.length > 3) inbox.items.shift();
  (await doc(ControlsDoc)).seq = i;
  const records = await doc(MemberRecordsDoc, PHONE, null);
  records.requests[`r${i}`] = { requestId: `r${i}`, createdAt: i, parts: [{ text: `回答 ${i}`, state: i % 3 ? "sent" : "sending" }] };
  delete records.requests[`r${i - 5}`];
  const receipts = await doc(ReceiptsDoc);
  receipts.items[`u${i}`] = { at: i, phone: PHONE, request: `r${i}` };
  delete receipts.items[`u${i - 10}`];
  const results = await doc(ResultsDoc);
  results.calls[`c${i}`] = { phone: PHONE, at: i, files: [`结果-${i}.txt`] };
  delete results.calls[`c${i - 4}`];
  (await doc(ReclamationItems, "item-a", { name: "item-a", call: {} })).next = `n${i}`;
  (await doc(ReclamationQueues, PHONE, null)).count = i;
  (await doc(Other)).n = i;
}

/**
 * A new conversation database at `path` as an older release left it: one conversation whose bot documents change in each
 * of `length` commits without ever writing a base, and a chain within the interval (10 revisions) beside them. It records
 * no space, so a service that discovers it reports it and leaves it alone.
 */
export async function writeLongChains(path: string, length: number): Promise<void> {
  const old = useCheckpointPolicy(NEVER);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const session = createSession(await openGroupStorage(path));
    try {
      const conversation = await session.commit(async tx => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      for (let i = 1; i <= length; i++) await session.commit(tx => change(tx, conversation, i), context);
      for (let i = 1; i <= 10; i++) await session.commit(async tx => { (await tx.doc(ReclamationQueues, "short", null)).count = i; }, context);
    } finally { await session.close(context); }
  } finally { old(); }
}

export type ChainState = { values: Record<number, string>; chains: Record<number, number>; nextSeq: number };
/** Every live document's value (independent fold, canonical JSON), its revision count, and the commit sequence. */
export function chainState(db: Database): ChainState {
  const ids = (db.query("SELECT id FROM documents WHERE retired_at IS NULL ORDER BY id").all() as { id: number }[]).map(row => row.id);
  const values = Object.fromEntries(ids.map(id => [id, canonical(documentValue(db, id).value)]));
  const chains = Object.fromEntries((db.query("SELECT document_id AS id, count(*) AS n FROM document_revisions GROUP BY document_id").all() as
    { id: number; n: number }[]).map(row => [row.id, row.n]));
  const nextSeq = (db.query("SELECT next_seq FROM durable_metadata").get() as { next_seq: number }).next_seq;
  return { values, chains, nextSeq };
}

/** The kind of document `id` (as stored: JSON text). */
export const kindOf = (db: Database, id: number): string =>
  JSON.parse((db.query("SELECT kind FROM documents WHERE id = ?").get(id) as { kind: string }).kind) as string;
