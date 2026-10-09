// Identity documents of the Durable store (D0 contract 2.2): the group is decided by which database, the member by the
// directory; tools and prompt sections read the identity document, never model arguments or a changeable cwd.
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineDoc, defineDocFamily, type Conversation, type ConversationId, type DocumentReader, type Harness, type ModelRef } from "@earendil-works/pi-durable";

/** Which group a database belongs to: written once on first open, checked on every later open. */
export type GroupState = { groupId: string; version: 1 };
export const GroupDoc = defineDoc<GroupState>({
  kind: "mixin.group",
  version: 1,
  scope: "session",
  initial: () => ({ groupId: "", version: 1 }),
});

/** One member (the server-confirmed phone) maps to exactly one ownerless conversation. */
export type MemberRecord = { conversationId: number; createdAt: number };
export const MemberDirectory = defineDocFamily<MemberRecord, MemberRecord>({
  kind: "mixin.member",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ ...seed }),
});

/** Conversation identity, written in the creating commit. */
export type IdentityState = { groupId: string; phone: string; version: 1 };
export const IdentityDoc = defineDoc<IdentityState>({
  kind: "mixin.identity",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork must never inherit a member identity (no fork tool in the first cut either).
  fork: "initial",
  initial: () => ({ groupId: "", phone: "", version: 1 }),
});

/** Record the group of a new database, or refuse a database that belongs to another group. */
export async function claimGroup(harness: Harness, groupId: string, context: Context): Promise<void> {
  if (!groupId) throw new Error("群标识为空");
  const recorded = await harness.commit(async (tx) => {
    const group = await tx.doc(GroupDoc);
    if (group.groupId === "") group.groupId = groupId;
    return group.groupId;
  }, context);
  if (recorded !== groupId) throw new Error("群数据库属于另一个群，已拒绝读取和写入");
}

/**
 * The group a database belongs to, or undefined before `claimGroup`. Read only; a bare `createSession(storage)` reads it
 * before a Harness opens the database, since opening a Harness recovers interrupted tasks (src/durable/groups.ts).
 */
export async function databaseGroup(reader: DocumentReader, context: Context): Promise<string | undefined> {
  return (await reader.snapshot(GroupDoc, context))?.groupId || undefined;
}

export interface AgentSetup { model: ModelRef; thinkingLevel?: ModelThinkingLevel }

/**
 * Get or create a member's conversation in one commit: directory lookup, ownerless conversation creation (which runs the
 * Harness's creation hook: the built-in `pi.*` documents, among them the conversation's own provider session id
 * `pi.provider`), agent configuration, identity and directory record. An existing conversation must carry the
 * same identity, and is configured again when the instance's model or thinking level changed; `ensureStorageIdentity` (src/agent/storage-identity.ts) still guards the member's directories.
 */
export async function memberConversation(harness: Harness, groupId: string, phone: string, agent: AgentSetup, context: Context,
  now: () => number = Date.now): Promise<{ conversation: Conversation; created: boolean }> {
  if (!groupId) throw new Error("群标识为空");
  if (!phone) throw new Error("成员标识为空");
  const result = await harness.commit(async (tx) => {
    const group = await tx.doc(GroupDoc);
    if (group.groupId !== groupId) throw new Error("群数据库属于另一个群，已拒绝读取和写入");
    const member = await tx.doc(MemberDirectory, phone, { conversationId: 0, createdAt: 0 });
    if (member.conversationId !== 0) {
      const id = member.conversationId as ConversationId;
      const identity = await tx.doc(IdentityDoc, id);
      if (identity.groupId !== groupId || identity.phone !== phone) throw new Error("成员会话的身份不一致，已拒绝读取和写入");
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
    identity.groupId = groupId;
    identity.phone = phone;
    member.conversationId = record.id;
    member.createdAt = now();
    return { id: record.id, created: true };
  }, context);
  const conversation = await harness.conversation(result.id, context);
  if (conversation === undefined) throw new Error(`成员会话 ${result.id} 不存在`);
  return { conversation, created: result.created };
}
