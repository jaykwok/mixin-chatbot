import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createSession } from '@earendil-works/pi-durable';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { clearAllGroups, clearGroup, collect } from '../../scripts/ops/history-admin.ts';
import { groupDatabasePath } from '../../src/durable/groups.ts';
import { memberConversation } from '../../src/durable/identity.ts';
import { ControlsDoc } from '../../src/durable/inbox.ts';
import { openGroupStorage } from '../../src/durable/sqlite.ts';
import { openStatsLedger, readLedger } from '../../src/agent/stats-ledger.ts';
import { projectConversation } from '../../src/durable/projection.ts';
import { fauxModels, openGroupHarness } from '../helpers/durable.ts';
import { tempFixture } from '../helpers/temp.ts';

test('current group history queues clear once per member and preserves statistics, reference files and tmp',async()=>{
 const f=await tempFixture('current-history-');const {faux,models,model}=fauxModels();
 const path=groupDatabasePath(f.root,'g');await mkdir(join(f.root,'g'),{recursive:true});
 const opened=await openGroupHarness(path,models,{group:'g'}),ledger=openStatsLedger(f.root);
 try{
  const {conversation}=await memberConversation(opened.harness,'g','u',{model},context);
  faux.setResponses([fauxAssistantMessage('answer')]);await(await conversation.submit({type:'input',content:'question'},context)).wait(context);
  await projectConversation(ledger,opened.harness,{groupId:'g',phone:'u',conversationId:conversation.id},context);
  await mkdir(join(f.root,'g/workspace'),{recursive:true});await writeFile(join(f.root,'g/workspace/keep.txt'),'material');
  await mkdir(join(f.root,'g/users/u/tmp'),{recursive:true});await writeFile(join(f.root,'g/users/u/tmp/keep.txt'),'draft');
  await opened.close();
  const before=readLedger(ledger),history=await collect(f.root);expect(history).toHaveLength(1);expect(history[0]!.database!.bytes).toBeGreaterThan(0);
  expect(await clearGroup('g',f.root)).toBe(0);expect(await clearGroup('g',f.root)).toBe(0);
  const session=createSession(await openGroupStorage(path));
  try{expect((await session.snapshot(ControlsDoc,context))!.pending).toHaveLength(1);}finally{await session.close(context);}
  expect(readLedger(ledger)).toEqual(before);expect(await readFile(join(f.root,'g/workspace/keep.txt'),'utf8')).toBe('material');
  expect(await readFile(join(f.root,'g/users/u/tmp/keep.txt'),'utf8')).toBe('draft');
 }finally{await opened.close();ledger.close();await f.cleanup();}
},20000);

test('history never imports unrecognized session files, refuses foreign groups, and handles an empty root',async()=>{
 const f=await tempFixture('history-current-gate-');
 try{
  expect(await clearAllGroups(f.root)).toBe(0);
  await mkdir(join(f.root,'g/users/u'),{recursive:true});await writeFile(join(f.root,'g/users/u/session.jsonl'),'unrecognized data');
  expect(await collect(f.root)).toEqual([]);expect(await readFile(join(f.root,'g/users/u/session.jsonl'),'utf8')).toBe('unrecognized data');
  const {models}=fauxModels();const path=groupDatabasePath(f.root,'g');const opened=await openGroupHarness(path,models,{group:'other'});await opened.close();
  expect(await clearGroup('g',f.root)).toBe(1);expect(await clearGroup('missing',f.root)).toBe(1);
 }finally{await f.cleanup();}
});
