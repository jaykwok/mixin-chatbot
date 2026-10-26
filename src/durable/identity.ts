import { randomUUID } from "node:crypto";
// Identity documents of the Durable store: the space (all direct chats, or one group) is decided by which database, the
// member by the directory; tools and prompt sections read the identity document, never model arguments or a changeable cwd.
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineDoc, defineDocFamily, type Conversation, type ConversationId, type DocumentReader, type Harness, type ModelRef } from "@earendil-works/pi-durable";
import { parseScopeKey, scopeKey, type Scope } from "../core/layout.ts";

/** Which space a database belongs to (`scopeKey`): written once on first open, checked on every later open. */
export type SpaceState = { space: string; generation: string; version: 1 };
export const SpaceDoc = defineDoc<SpaceState>({
  kind: "mixin.space",
  version: 1,
  checkpointWhen: () => false,
  scope: "session",
  initial: () => ({ space: "", generation: randomUUID(), version: 1 }),
});
const generationValid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

/** One member (the server-confirmed phone) maps to exactly one ownerless conversation. */
export type MemberRecord = { conversationId: number; createdAt: number };
export const MemberDirectory = defineDocFamily<MemberRecord, MemberRecord>({
  kind: "mixin.member",
  version: 1,
  checkpointWhen: () => false,
  scope: "session",
  family: true,
  initial: (seed) => ({ ...seed }),
});

/** Conversation identity (space key and phone), written in the creating commit. */
export type IdentityState = { space: string; phone: string; version: 1 };
export const IdentityDoc = defineDoc<IdentityState>({
  kind: "mixin.member-identity",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  // A fork must never inherit a member identity (no fork tool in the first cut either).
  fork: "initial",
  initial: () => ({ space: "", phone: "", version: 1 }),
});

/** Record the space of a new database, or refuse a database that belongs to another space. */
export async function claimSpace(harness: Harness, scope: Scope, context: Context): Promise<void> {
  const key = scopeKey(scope);
  const recorded = await harness.commit(async (tx) => {
    const space = await tx.doc(SpaceDoc);
    if (!generationValid(space.generation)) throw new Error("会话库格式不匹配，请使用当前格式新库");
    if (space.space === "") space.space = key;
    return space.space;
  }, context);
  if (recorded !== key) throw new Error("会话库属于另一个空间，已拒绝读取和写入");
}

/**
 * The space a database belongs to, or undefined before `claimSpace`. Read only; a bare `createSession(storage)` reads it
 * before a Harness opens the database, since opening a Harness recovers interrupted tasks (src/durable/spaces.ts).
 */
export async function databaseSpace(reader: DocumentReader, context: Context): Promise<Scope | undefined> {
  const space = await reader.snapshot(SpaceDoc, context);
  if (!space?.space) return undefined;
  const scope = parseScopeKey(space.space);
  if (!scope || !generationValid(space.generation)) throw new Error("会话库格式不匹配，拒绝恢复运行任务");
  return scope;
}

export interface AgentSetup { model: ModelRef; thinkingLevel?: ModelThinkingLevel }

/**
 * Get or create a member's conversation in one commit: directory lookup, ownerless conversation creation (which runs the
 * Harness's creation hook: the built-in `pi.*` documents, among them the conversation's own provider session id
 * `pi.provider`), agent configuration, identity and directory record. An existing conversation must carry the
 * same identity, and is configured again when the instance's model or thinking level changed; `ensureStorageIdentity` (src/agent/storage-identity.ts) still guards the member's directories.
 */
export async function memberConversation(harness: Harness, scope: Scope, phone: string, agent: AgentSetup, context: Context,
  now: () => number = Date.now): Promise<{ conversation: Conversation; created: boolean }> {
  if (!phone) throw new Error("成员标识为空");
  const key = scopeKey(scope);
  const result = await harness.commit(async (tx) => {
    const space = await tx.doc(SpaceDoc);
    if (space.space !== key) throw new Error("会话库属于另一个空间，已拒绝读取和写入");
    const member = await tx.doc(MemberDirectory, phone, { conversationId: 0, createdAt: 0 });
    if (member.conversationId !== 0) {
      const id = member.conversationId as ConversationId;
      const identity = await tx.doc(IdentityDoc, id);
      if (identity.space !== key || identity.phone !== phone) throw new Error("成员会话的身份不一致，已拒绝读取和写入");
      // The instance has one model: an existing member follows a changed selection from its next message on.
      const stored = await tx.doc(AgentDoc, id);
      const thinkingLevel = agent.thinkingLevel ?? "off";
      if (stored.model?.provider !== agent.model.provider || stored.model?.modelId !== agent.model.modelId || stored.thinkingLevel !== thinkingLevel) {
        await configure(tx, id, { model: agent.model, thinkingLevel });
      }
      return { id, created: false };
    }
    const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, record.id, { model: agent.model, thinkingLevel: agent.thinkingLevel ?? "off" });
    const identity = await tx.doc(IdentityDoc, record.id);
    identity.space = key;
    identity.phone = phone;
    member.conversationId = record.id;
    member.createdAt = now();
    return { id: record.id, created: true };
  }, context);
  const conversation = await harness.conversation(result.id, context);
  if (conversation === undefined) throw new Error(`成员会话 ${result.id} 不存在`);
  return { conversation, created: result.created };
}
