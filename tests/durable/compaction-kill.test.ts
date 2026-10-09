import { afterAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, ProviderDoc, type ConversationId } from "@earendil-works/pi-durable";
import { AttemptsDoc } from "../../src/durable/attempts.ts";
import { MemberDirectory } from "../../src/durable/identity.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("compaction-kill-");
afterAll(() => fixture.cleanup());
const spec = (name: string) => JSON.stringify(import.meta.resolve(name));
const child = `
import { BACKGROUND_CONTEXT as context } from ${spec("@earendil-works/chord/context")};
import { CompactionTask, LiveDoc, ProviderDoc } from ${spec("@earendil-works/pi-durable")};
import { fauxAssistantMessage } from ${spec("@earendil-works/pi-ai/providers/faux")};
import { memberConversation } from ${spec("../../src/durable/identity.ts")};
import { fauxModels, openGroupHarness } from ${spec("../helpers/durable.ts")};
const [path, mode] = process.argv.slice(2), {faux, models, model} = fauxModels();
faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second'), async () => { console.log('READY'); return await new Promise(() => {}); }]);
const opened = await openGroupHarness(path, models, {settings:{compaction:{enabled:false, keepRecentTokens:1}}});
const {conversation} = await memberConversation(opened.harness, 'group-a', 'member', {model}, context);
for (const content of ['one', 'two']) await (await conversation.submit({type:'input',content}, context)).wait(context);
const provider = await opened.harness.snapshot(ProviderDoc, conversation.id, context);
const taskId = await opened.harness.commit(async tx => {
  const task = await tx.createTask(CompactionTask, {reason:'manual'}, {ownership:{kind:'conversation'}, conversationId:conversation.id, background:mode === 'background'});
  const live = await tx.doc(LiveDoc, conversation.id);
  live.compactions ??= []; live.compactions.push({taskId:task,reason:'manual',blocking:false,attempt:1});
  return task;
}, context);
console.log('TASK '+JSON.stringify({taskId, provider}));
await new Promise(() => {});
`;

test.each(["manual", "background"] as const)("force-kill during %s summary resumes the same task and keeps unconfirmed usage", async mode => {
  const path = join(fixture.root, `${mode}.sqlite`), script = join(fixture.root, `child-${mode}.ts`);
  await writeFile(script, child);
  const proc = Bun.spawn([process.execPath, script, path, mode], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const errors = new Response(proc.stderr).text(); let output = "";
  const timer = setTimeout(() => proc.kill("SIGKILL"), 25000);
  try { for await (const bytes of proc.stdout) { output += Buffer.from(bytes).toString(); if (output.includes("READY\n") && output.includes("TASK ")) break; } }
  finally { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; }
  expect(output, await errors).toContain("READY\n");
  const { taskId, provider } = JSON.parse(/^TASK (.+)$/m.exec(output)![1]!);
  const { faux, models } = fauxModels(); faux.setResponses([fauxAssistantMessage("recovered summary")]);
  const opened = await openGroupHarness(path, models, { settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
  try {
    const id = (await opened.harness.snapshot(MemberDirectory, "member", context))!.conversationId as ConversationId;
    expect(await opened.harness.snapshot(ProviderDoc, id, context)).toEqual(provider);
    const result = await opened.harness.waitForTask(taskId, context);
    expect(result.state.status).toBe("terminal");
    if (result.state.status !== "terminal") throw new Error("compaction did not terminate");
    expect(result.state.outcome.status).toBe("completed"); expect(faux.state.callCount).toBe(1);
    const live = await opened.harness.snapshot(LiveDoc, id, context); expect(live?.compactions ?? []).toEqual([]);
    const starts = Object.values((await opened.harness.snapshot(AttemptsDoc, id, context))!.starts).filter(start => start.kind === "compaction");
    expect(starts).toHaveLength(2); expect(starts[0]!.taskId).toBe(taskId); expect(starts[1]!.taskId).toBe(taskId);
    expect(starts.filter(start => start.usage === undefined)).toHaveLength(1);
    expect(starts.find(start => start.usage !== undefined)!.usage!.cost.total).toBe(0);
    const conversation = await opened.harness.conversation(id, context);
    const deadline = Date.now() + 5000;
    while (!JSON.stringify(await conversation!.context(context)).includes("recovered summary") && Date.now() < deadline) await Bun.sleep(10);
    expect(JSON.stringify(await conversation!.context(context))).toContain("recovered summary");
    expect(opened.reports).toEqual([]);
  } finally { await opened.close(); }
}, 45000);
