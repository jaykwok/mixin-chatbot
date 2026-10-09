// The import protocol of historical migrations into the Durable store (data version 3 on).
//
// Migrations write a group database only through here: pi-durable's official Session/Tx interfaces over the service's
// storage facade (src/durable/sqlite.ts, the one place this module reaches into production code: the storage format
// must be the one the service opens). The documents are frozen copies of the service's definitions (same kind, version
// and semantics; tests/ops/migrations.test.ts compares them), so a later change to the service's documents does not
// change what an old migration writes. A Harness is opened paused, with an empty registry and no model providers, only
// so that creating a conversation writes the built-in `pi.*` documents; nothing resumes it, submits or waits, so no
// task, tool or request can run. Should the storage format or these interfaces ever change, freeze a copy here.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  AssistantEntry, type ConversationId, createRegistry, createSession, defineDoc, defineDocFamily, Harness,
  type Storage, ToolResultEntry, UserEntry,
} from "@earendil-works/pi-durable";
import { openGroupStorage } from "../../../src/durable/sqlite.ts";

const context: Context = BACKGROUND_CONTEXT;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Frozen copy of src/durable/identity.ts `GroupDoc`. */
export const GroupDoc = defineDoc<{ groupId: string; version: 1 }>({
  kind: "mixin.group", version: 1, scope: "session", initial: () => ({ groupId: "", version: 1 }),
});
/** Frozen copy of src/durable/identity.ts `MemberDirectory`. */
export const MemberDirectory = defineDocFamily<{ conversationId: number; createdAt: number }, { conversationId: number; createdAt: number }>({
  kind: "mixin.member", version: 1, scope: "session", family: true, initial: (seed) => ({ ...seed }),
});
/** Frozen copy of src/durable/identity.ts `IdentityDoc`. */
export const IdentityDoc = defineDoc<{ groupId: string; phone: string; version: 1 }>({
  kind: "mixin.identity", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ groupId: "", phone: "", version: 1 }),
});
/** Frozen copy of src/durable/codemode/index.ts `CodemodeStoreDoc`. */
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
  kind: "mixin.codemode-store", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ values: {} }),
});

/** What the import of one legacy session wrote; src/durable/projection.ts reads `through`. */
export type LegacyImport = {
  version: 1;
  /** The session file, relative to the group root, and its content as imported. */
  source: string;
  sha256: string;
  bytes: number;
  /** Entries imported; the newest is `through` (0 when none): usage at or before it was counted by the old ledger. */
  entries: number;
  through: number;
  /** The history ended mid-turn (a question without an answer, a failed answer or calls without results). */
  interrupted: boolean;
  importedAt: number;
};
/** Frozen copy of src/durable/projection.ts `LegacyImportDoc`. */
export const LegacyImportDoc = defineDoc<LegacyImport>({
  kind: "mixin.legacy-import", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ version: 1, source: "", sha256: "", bytes: 0, entries: 0, through: 0, interrupted: false, importedAt: 0 }),
});

/** One member's history to import, already converted to model messages in context order. */
export interface MemberImport {
  phone: string;
  messages: Message[];
  store: Record<string, JsonValue>;
  record: Omit<LegacyImport, "version" | "entries" | "through" | "importedAt">;
}

export type ImportOutcome = "imported" | "already-imported";

const LIVE_TASKS = ["pending", "running", "waiting", "completing"] as const;
const UNSETTLED = ["queued", "placed"] as const;

/** Refuse a database with Durable work: opening a Harness would recover it, which only the service may do. */
async function assertIdle(storage: Storage): Promise<void> {
  for (const status of LIVE_TASKS) if ((await storage.scanTasks({ status }, 1, undefined, context)).items.length) throw new Error("群数据库已有运行中的 Durable 任务，拒绝迁移导入");
  for (const status of UNSETTLED) if ((await storage.scanSubmissions({ status }, 1, undefined, context)).items.length) throw new Error("群数据库已有未结算的 Durable 提交，拒绝迁移导入");
}

/**
 * Import members of one group into `<group directory>/durable.sqlite`, one commit per member: `each` hands over one
 * member at a time (read when asked, so a group's histories are never all in memory) and gets the outcome back.
 */
export async function importGroup(path: string, groupId: string,
  each: (put: (member: MemberImport) => Promise<ImportOutcome>) => Promise<void>, now: () => number = Date.now): Promise<void> {
  const storage = await openGroupStorage(path);
  let harness: Harness | undefined;
  try {
    await assertIdle(storage);
    harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
    const opened = harness;
    const recorded = await opened.commit(async (tx) => {
      const group = await tx.doc(GroupDoc);
      if (group.groupId === "") group.groupId = groupId;
      return group.groupId;
    }, context);
    if (recorded !== groupId) throw new Error(`群数据库属于另一个群：${path}`);
    await each((member) => opened.commit(async (tx): Promise<ImportOutcome> => {
      const directory = await tx.doc(MemberDirectory, member.phone, { conversationId: 0, createdAt: 0 });
      if (directory.conversationId !== 0) {
        const id = directory.conversationId as ConversationId;
        const imported = await tx.doc(LegacyImportDoc, id);
        if (imported.sha256 === member.record.sha256 && imported.source === member.record.source) return "already-imported";
        throw new Error(`成员已有 Durable 会话，但不是由这份会话文件导入的：${member.record.source}`);
      }
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const identity = await tx.doc(IdentityDoc, conversation.id);
      identity.groupId = groupId;
      identity.phone = member.phone;
      directory.conversationId = conversation.id;
      directory.createdAt = now();
      let through = 0;
      for (const message of member.messages) {
        const entry = message.role === "user" ? await tx.appendEntry(UserEntry, conversation.id, { model: [message] })
          : message.role === "assistant" ? await tx.appendEntry(AssistantEntry, conversation.id, { model: [message] })
          : await tx.appendEntry(ToolResultEntry, conversation.id, { model: [message], data: { diagnostics: [] } });
        through = entry.id as number;
      }
      if (Object.keys(member.store).length) (await tx.doc(CodemodeStoreDoc, conversation.id)).values = member.store;
      Object.assign(await tx.doc(LegacyImportDoc, conversation.id), {
        version: 1, ...member.record, entries: member.messages.length, through, importedAt: now(),
      } satisfies LegacyImport);
      return "imported";
    }, context));
  } finally {
    if (harness) await harness.close(context);
    else await storage.close(context);
  }
}

/** Read-only check of a group database: its group and each listed member's import record. */
export async function readGroupImports(path: string, phones: string[]): Promise<{ groupId: string | undefined; imports: Map<string, LegacyImport | undefined> }> {
  const storage = await openGroupStorage(path);
  try {
    const session = createSession(storage);
    const groupId = (await session.snapshot(GroupDoc, context))?.groupId || undefined;
    const imports = new Map<string, LegacyImport | undefined>();
    for (const phone of phones) {
      const directory = await session.snapshot(MemberDirectory, phone, context);
      const id = directory?.conversationId;
      imports.set(phone, id ? (await session.snapshot(LegacyImportDoc, id as ConversationId, context)) as LegacyImport | undefined : undefined);
    }
    return { groupId, imports };
  } finally { await storage.close(context); }
}

