import { afterAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempFixture } from "../helpers/temp.ts";

const f = await tempFixture("auxiliary-kill-"); afterAll(() => f.cleanup());
const spec = (name: string) => JSON.stringify(import.meta.resolve(name));
const program = `
import { BACKGROUND_CONTEXT as context } from ${spec("@earendil-works/chord/context")};
import { createRegistry, defineExtension, Harness } from ${spec("@earendil-works/pi-durable")};
import { fauxAssistantMessage, fauxToolCall } from ${spec("@earendil-works/pi-ai/providers/faux")};
import { AuxiliaryBudget, auxiliaryMemberTools } from ${spec("../../src/durable/auxiliary.ts")};
import { AuxiliaryDoc } from ${spec("../../src/durable/auxiliary-records.ts")};
import { groupDoor } from ${spec("../../src/durable/models.ts")};
import { claimGroup, memberConversation } from ${spec("../../src/durable/identity.ts")};
import { memberRegistration } from ${spec("../../src/durable/tools.ts")};
import { openGroupStorage } from ${spec("../../src/durable/sqlite.ts")};
import { fauxModels } from ${spec("../helpers/durable.ts")};
const [path, root, phase] = process.argv.slice(2);
const { models, faux, model } = fauxModels(); let calls = 0;
const classifier = {type:'classifier',api:'fixture',id:'route',name:'route',provider:'aux',baseUrl:'https://fixture.invalid',input:['text'],contextWindow:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
models.setProvider({...faux.provider,id:'aux',name:'aux',getModels:()=>[],getAllModels:()=>[classifier],auth:{apiKey:{name:'fixture',resolve:async()=>({auth:{apiKey:'fixture'}})}},classify:async()=>{
  calls++; console.log('DISPATCH');
  if(phase==='start') return await new Promise(()=>{});
  return {api:'fixture',provider:'aux',model:'route',answers:{route:{type:'choice',choice:'text',confidence:1,probabilities:{text:1}}},stopReason:'stop',timestamp:Date.now()};
}});
faux.setResponses(phase==='start' ? [fauxAssistantMessage([fauxToolCall('document_route',{text:'page'},{id:'route-kill'})],{stopReason:'toolUse'})] : [fauxAssistantMessage('after recovery')]);
const holder={}, door=groupDoor(holder,{startTries:1}), registry=createRegistry(); registry.install(door.extension());
const tools=auxiliaryMemberTools({root,groupId:'group-a'},door,{format:1,classifier:{provider:'aux',modelId:'route'},maxConcurrent:1,classifierRetries:0},new AuxiliaryBudget(1));
registry.install(defineExtension({name:'mixin.auxiliary',tools:tools.map(memberRegistration)}));
const harness=await Harness.open(await openGroupStorage(path),{registry,models:door.wrap(models),settings:{retry:{maxRetries:0},compaction:{enabled:false}}},context);
holder.harness=harness; await claimGroup(harness,'group-a',context);
const {conversation}=await memberConversation(harness,'group-a','alice',{model},context);
if(phase==='start') {
  const submission=await conversation.submit({type:'input',content:'route'},context);
  console.log('TASK '+JSON.stringify({submissionId:submission.id})); await submission.wait(context);
} else {
  await (await harness.submission(Number(process.argv[5]),context)).wait(context);
  const starts=Object.values((await harness.snapshot(AuxiliaryDoc,conversation.id,context)).starts);
  const history=(await conversation.entries({},200,undefined,context)).items.flatMap(e=>e.model??[]);
  console.log('RESULT '+JSON.stringify({calls,starts,tool:history.find(m=>m.role==='toolResult'&&m.toolCallId==='route-kill')}));
}
await door.close(); await harness.close(context);
`;

test("force-kill after an auxiliary dispatch preserves unknown usage and never replays the unsafe tool", async () => {
  const script = join(f.root, "child.ts"), path = join(f.root, "group.sqlite"); await writeFile(script, program);
  const child = Bun.spawn([process.execPath, script, path, f.root, "start"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const errors = new Response(child.stderr).text(); let output = "";
  const deadline = setTimeout(() => child.kill("SIGKILL"), 22000);
  try { for await (const bytes of child.stdout) { output += Buffer.from(bytes).toString(); if (output.includes("DISPATCH") && output.includes("TASK ")) break; } }
  finally { clearTimeout(deadline); child.kill("SIGKILL"); await child.exited; }
  expect(output, await errors).toContain("DISPATCH");
  const { submissionId } = JSON.parse(/^TASK (.+)$/m.exec(output)![1]!);
  const recovery = Bun.spawn([process.execPath, script, path, f.root, "recover", String(submissionId)], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const recoveryDeadline = setTimeout(() => recovery.kill(), 22000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(recovery.stdout).text(), new Response(recovery.stderr).text(), recovery.exited]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(/^RESULT (.+)$/m.exec(stdout)![1]!);
    expect(result.calls).toBe(0); expect(result.starts).toHaveLength(1);
    expect(result.starts[0].usage).toBeUndefined(); expect(result.starts[0].outcome).toBeUndefined();
    expect(result.tool.isError).toBe(true);
  } finally { clearTimeout(recoveryDeadline); recovery.kill(); await recovery.exited; }
}, 50000);
