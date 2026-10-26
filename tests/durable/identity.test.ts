import { afterAll, describe, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type CommitPublication, Harness, ProviderDoc } from "@earendil-works/pi-durable";
import { claimSpace, databaseSpace, IdentityDoc, memberConversation, MemberDirectory } from "../../src/durable/identity.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, harnessOptions } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf } from "../helpers/layout.ts";

const fixture = await tempFixture("durable-identity-");
afterAll(() => fixture.cleanup());
const { faux, models, model } = fauxModels();
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let counter = 0;

async function withHarness(use: (harness: Harness) => Promise<void>, path = join(fixture.root, `db-${++counter}.sqlite`)) {
  const harness = await Harness.open(await openGroupStorage(path), harnessOptions(models)(), context);
  try { await use(harness); } finally { await harness.close(context); }
  return path;
}

describe("Durable identity documents", () => {
  test("a database records its space once and refuses another space, across reopen", async () => {
    const path = await withHarness(async (harness) => {
      expect(await databaseSpace(harness, context)).toBeUndefined();
      await claimSpace(harness, scopeOf("group-a"), context);
      await claimSpace(harness, scopeOf("group-a"), context);
      expect(await databaseSpace(harness, context)).toEqual(scopeOf("group-a"));
    });
    await withHarness(async (harness) => {
      await expect(claimSpace(harness, scopeOf("group-b"), context)).rejects.toThrow("属于另一个空间");
      await expect(claimSpace(harness, scopeOf("direct"), context)).rejects.toThrow("属于另一个空间");
      expect(await databaseSpace(harness, context)).toEqual(scopeOf("group-a"));
    }, path);
    // The direct space claims a database the same way, and a group whose id is "direct" is another space.
    const direct = await withHarness(async (harness) => {
      await claimSpace(harness, scopeOf("direct"), context);
      expect(await databaseSpace(harness, context)).toEqual(scopeOf("direct"));
    });
    await withHarness(async (harness) => {
      await expect(claimSpace(harness, { kind: "group", groupId: "direct" }, context)).rejects.toThrow("属于另一个空间");
    }, direct);
  });

  test("concurrent get-or-create gives each member exactly one configured conversation with its identity", async () => {
    await withHarness(async (harness) => {
      await claimSpace(harness, scopeOf("group-a"), context);
      const results = await Promise.all(["m1", "m2", "m1", "m2", "m1"].map((phone) =>
        memberConversation(harness, scopeOf("group-a"), phone, { model }, context, () => 1234)));
      for (const [phone, indexes] of [["m1", [0, 2, 4]], ["m2", [1, 3]]] as const) {
        const own = indexes.map((i) => results[i]!);
        expect(new Set(own.map((result) => result.conversation.id)).size).toBe(1);
        expect(own.filter((result) => result.created)).toHaveLength(1);
        const id = own[0]!.conversation.id;
        expect(await harness.snapshot(IdentityDoc, id, context)).toEqual({ space: "group:group-a", phone, version: 1 });
        expect(await harness.snapshot(MemberDirectory, phone, context)).toEqual({ conversationId: id, createdAt: 1234 });
        const agent = await own[0]!.conversation.agent(context);
        expect(agent.model).toEqual(model);
        expect(agent.thinkingLevel).toBe("off");
      }
      expect(results[0]!.conversation.id).not.toBe(results[1]!.conversation.id);
    });
  });

  test("an unclaimed database, another space's database and a mismatched identity are refused without writing", async () => {
    await withHarness(async (harness) => {
      await expect(memberConversation(harness, scopeOf("group-a"), "m1", { model }, context)).rejects.toThrow("属于另一个空间");
      expect(await databaseSpace(harness, context)).toBeUndefined();
      await claimSpace(harness, scopeOf("group-a"), context);
      await expect(memberConversation(harness, scopeOf("group-b"), "m1", { model }, context)).rejects.toThrow("属于另一个空间");
      await expect(memberConversation(harness, scopeOf("direct"), "m1", { model }, context)).rejects.toThrow("属于另一个空间");
      expect(await harness.snapshot(MemberDirectory, "m1", context)).toBeUndefined();
      const { conversation } = await memberConversation(harness, scopeOf("group-a"), "m1", { model }, context);
      await harness.commit(async (tx) => { (await tx.doc(IdentityDoc, conversation.id)).phone = "m2"; }, context);
      await expect(memberConversation(harness, scopeOf("group-a"), "m1", { model }, context)).rejects.toThrow("身份不一致");
      await expect(memberConversation(harness, scopeOf("group-a"), "", { model }, context)).rejects.toThrow("成员标识为空");
    });
  });

  // Pi 1.0.2 and 1.0.3: Durable's built-in pi.provider document, sent to the provider as sessionId (details: D0 probe p11).
  test("each member conversation gets its own provider identity in its creating commit; requests carry it; reopen keeps it", async () => {
    const ids: Record<string, string | undefined> = {};
    const sent: unknown[] = [];
    faux.setResponses([(_transcript, options) => { sent.push(options?.sessionId); return fauxAssistantMessage("好"); }]);
    const path = await withHarness(async (harness) => {
      await claimSpace(harness, scopeOf("group-a"), context);
      const commits: CommitPublication[] = [];
      const unsubscribe = harness.subscribeCommits((publication) => commits.push(publication));
      const members = { m1: await memberConversation(harness, scopeOf("group-a"), "m1", { model }, context), m2: await memberConversation(harness, scopeOf("group-a"), "m2", { model }, context) };
      unsubscribe();
      for (const [phone, { conversation }] of Object.entries(members)) {
        ids[phone] = (await harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId;
        expect(ids[phone]).toMatch(UUIDV7);
        const creating = commits.find((publication) => publication.changes.some((change) => change.type === "conversation" && change.value.id === conversation.id));
        expect(creating?.changes.some((change) => change.type === "document" && change.record.kind === "pi.provider" && change.conversationId === conversation.id)).toBe(true);
      }
      expect(ids.m1).not.toBe(ids.m2);
      const settled = await (await members.m1.conversation.submit({ type: "input", content: "你好" }, context)).wait(context);
      expect(settled.status).toBe("done");
      expect(sent).toEqual([ids.m1]);
    });
    await withHarness(async (harness) => {
      const { conversation, created } = await memberConversation(harness, scopeOf("group-a"), "m1", { model }, context);
      expect(created).toBe(false);
      expect((await harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId).toBe(ids.m1);
    }, path);
  });
});
