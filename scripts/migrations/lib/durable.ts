// The import protocol of historical migrations into the Durable store (data version 3 on).
//
// Migrations write a group database only through here: pi-durable's official Session/Tx interfaces over the service's
// storage facade (src/durable/sqlite.ts, the one place this module reaches into production code: the storage format
// must be the one the service opens). The documents are frozen copies of the service's definitions (same kind, version
// and semantics; tests/ops/migration-v3.test.ts compares them), so a later change to the service's documents does not
// change what an old migration writes. A Harness is opened paused, with an empty registry and no model providers, only
// so that creating a conversation writes the built-in `pi.*` documents; nothing resumes it, submits or waits, so no
// task, tool or request can run. Should the storage format or these interfaces ever change, freeze a copy here.
import { type Context, copyJson } from "@earendil-works/chord";
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
/** Frozen copy of src/durable/codemode/index.ts `CodemodeStoreDoc` up to data version 4 (the project's own codemode). */
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
  kind: "mixin.codemode-store", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ values: {} }),
});
/** Frozen copy of pi-durable 1.2.0 `@earendil-works/pi-durable/codemode` `CodemodeStoreDoc` (data version 5 on). */
export const OfficialCodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
  kind: "pi.codemode.store", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", initial: () => ({ values: {} }),
});
/**
 * Data version 5's boundary of a copied store: `through` is the conversation's newest entry when its values were copied
 * (0 when it had none), `copiedAt` the time. The old store kept no history, so the official store has none before the
 * copy: read as of an entry up to `through`, or forked there, it is empty, not the copied values. Written only by v5.
 */
export const CodemodeStoreBoundaryDoc = defineDoc<{ version: 1; through: number; copiedAt: number }>({
  kind: "mixin.codemode-store-boundary", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ version: 1, through: 0, copiedAt: 0 }),
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

/** Every conversation of a group database, oldest first. */
async function conversations(storage: Storage): Promise<ConversationId[]> {
  const ids: ConversationId[] = [];
  let cursor;
  do {
    const page = await storage.scanConversations({}, 200, cursor, context);
    ids.push(...page.items.map((conversation) => conversation.id));
    cursor = page.next;
  } while (cursor !== undefined);
  return ids;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (values: Record<string, JsonValue>) => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

export type StoreCopy = { conversationId: number; keys: number; through: number; outcome: "copied" | "already-copied" };

/**
 * Data version 5: copy each conversation's script store (`store()`/`load()`) from the project's document
 * (`mixin.codemode-store`) to the official one (`pi.codemode.store`), one commit per conversation, through a bare Session:
 * no Harness, so no task recovers or runs. The old document stays (old code reads it after a rollback). A conversation
 * whose official store already holds these values is left as is (a repeated run); one holding other values, or the same
 * values without this step's boundary record, stops the migration: only this step writes it before the service runs data
 * version 5. The commit that copies also records the boundary (`CodemodeStoreBoundaryDoc`). A conversation without
 * stored values is only read (`tx.doc` would create the document it names).
 */
export async function copyCodemodeStores(path: string): Promise<StoreCopy[]> {
  const storage = await openGroupStorage(path);
  try {
    // Never closed (closing would close the storage), so it keeps no document past a call.
    const session = createSession(storage, { documentRetentionMs: 0 });
    const copies: StoreCopy[] = [];
    for (const id of await conversations(storage)) {
      if (Object.keys((await session.snapshot(CodemodeStoreDoc, id, context))?.values ?? {}).length === 0) continue;
      const recorded = await session.snapshot(CodemodeStoreBoundaryDoc, id, context);
      const outcome = await session.commit(async (tx) => {
        const old = (await tx.doc(CodemodeStoreDoc, id)).values;
        if (Object.keys(old).length === 0) return undefined;
        const official = await tx.doc(OfficialCodemodeStoreDoc, id);
        if (Object.keys(official.values).length === 0) {
          // A draft is a proxy: copied as JSON (structuredClone refuses it).
          official.values = copyJson(old) as Record<string, JsonValue>;
          const through = (await tx.scanEntries({ conversationId: id }, 1)).items[0]?.id ?? 0;
          Object.assign(await tx.doc(CodemodeStoreBoundaryDoc, id), { version: 1, through, copiedAt: Date.now() });
          return "copied" as const;
        }
        if (sameJson(sorted(official.values), sorted(old))) {
          if (!recorded?.copiedAt) throw new Error(`会话 ${id} 的官方 codemode store 已有值但没有迁移边界记录，拒绝继续：${path}`);
          return "already-copied" as const;
        }
        throw new Error(`会话 ${id} 的官方 codemode store 已有不同的值，拒绝覆盖：${path}`);
      }, context);
      if (outcome) copies.push({ conversationId: id as number, keys: Object.keys((await session.snapshot(CodemodeStoreDoc, id, context))?.values ?? {}).length,
        through: (await session.snapshot(CodemodeStoreBoundaryDoc, id, context))!.through, outcome });
    }
    return copies;
  } finally { await storage.close(context); }
}

/** Read-only check of a group database: conversations whose official store does not hold their old store's values, or
 * whose boundary is not recorded. */
export async function uncopiedCodemodeStores(path: string): Promise<number[]> {
  const storage = await openGroupStorage(path);
  try {
    const session = createSession(storage, { documentRetentionMs: 0 });
    const missing: number[] = [];
    for (const id of await conversations(storage)) {
      const old = (await session.snapshot(CodemodeStoreDoc, id, context))?.values ?? {};
      if (Object.keys(old).length === 0) continue;
      const official = (await session.snapshot(OfficialCodemodeStoreDoc, id, context))?.values ?? {};
      const recorded = (await session.snapshot(CodemodeStoreBoundaryDoc, id, context))?.copiedAt;
      if (!recorded || !sameJson(sorted(official as Record<string, JsonValue>), sorted(old as Record<string, JsonValue>))) missing.push(id as number);
    }
    return missing;
  } finally { await storage.close(context); }
}

