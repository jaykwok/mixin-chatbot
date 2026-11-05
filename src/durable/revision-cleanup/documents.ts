// The documents the revision cleanup may rewrite, and the digests it records instead of their values.
import { createHash } from "node:crypto";
import { IdentityDoc, MemberDirectory, SpaceDoc } from "../identity.ts";
import { ControlsDoc, InboxDoc } from "../inbox.ts";
import { MemberRecordsDoc, ReceiptsDoc } from "../records.ts";
import { ResultsDoc } from "../results/ownership.ts";
import { ReclamationItems, ReclamationQueues } from "../results/queue.ts";

/** The kinds of the bot's own documents. */
const BOT_KINDS = new Set(([SpaceDoc, MemberDirectory, IdentityDoc, InboxDoc, ControlsDoc, MemberRecordsDoc, ReceiptsDoc, ResultsDoc,
  ReclamationItems, ReclamationQueues] as unknown as { definition: { kind: string } }[]).map(token => token.definition.kind));

/** The stored record of a document (`documents.record`): the address Durable resolves it by. */
export type StoredRecord = {
  id: number;
  kind: string;
  key?: string;
  scope: { kind: "session" } | { kind: "conversation"; conversationId: number } | { kind: "task"; taskId: number };
  retiredAt?: number;
};

/** Why a document is left alone, or undefined when the cleanup handles it. */
export function unsupported(record: StoredRecord): string | undefined {
  if (!BOT_KINDS.has(record.kind)) return "不是本程序的文档";
  if (record.retiredAt !== undefined) return "已退役";
  if (record.scope.kind === "task") return "任务范围的文档";
  return undefined;
}

/** JSON with object keys sorted: equal for equal values, whatever order the keys were added in. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, (item as Record<string, unknown>)[name]]))
    : item);
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const valueDigest = (value: unknown): string => sha256(canonical(value));
