import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createSession } from '@earendil-works/pi-durable';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { clearAllSpaces, clearSpace, collect } from '../../scripts/ops/history-admin.ts';
import { memberConversation } from '../../src/durable/identity.ts';
import { ControlsDoc } from '../../src/durable/inbox.ts';
import { openGroupStorage } from '../../src/durable/sqlite.ts';
import { openStatsLedger, readLedger } from '../../src/agent/stats-ledger.ts';
import { syncMemberStats } from '../../src/durable/projection.ts';
import { appLayout } from '../../src/core/layout.ts';
import { fauxModels, openGroupHarness } from '../helpers/durable.ts';
import { tempFixture } from '../helpers/temp.ts';
import { databaseOf, scopeOf, statsOf, tmpOf } from '../helpers/layout.ts';

async function pending(path:string){
 const session=createSession(await openGroupStorage(path));
 try{return (await session.snapshot(ControlsDoc,context))?.pending.length??0;}finally{await session.close(context);}
}

test('clearing one space queues clear once per member and preserves statistics, shared materials, tmp and the other space',async()=>{
 const f=await tempFixture('current-history-');const {faux,models,model}=fauxModels();
 const ledger=openStatsLedger(statsOf(f.root)),paths:Record<string,string>={};
 try{
  for(const space of ['g','direct']){
   const path=paths[space]=databaseOf(f.root,space);await mkdir(dirname(path),{recursive:true});
   const opened=await openGroupHarness(path,models,{scope:scopeOf(space)});
   try{
    const {conversation}=await memberConversation(opened.harness,scopeOf(space),'u',{model},context);
    faux.setResponses([fauxAssistantMessage('answer')]);await(await conversation.submit({type:'input',content:'question'},context)).wait(context);
    await syncMemberStats(ledger,opened.harness,{scope:scopeOf(space),phone:'u',conversationId:conversation.id},context);
   }finally{await opened.close();}
  }
  const workspace=appLayout(f.root).workspace,tmp=tmpOf(f.root,'g','u');
  await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'keep.txt'),'material');
  await mkdir(tmp,{recursive:true});await writeFile(join(tmp,'keep.txt'),'draft');
  const before=readLedger(ledger),history=await collect(f.root);expect(before.usage.length).toBe(2);
  expect(history.map(space=>space.space).sort()).toEqual(['direct','groups/g']);expect(history[0]!.database!.bytes).toBeGreaterThan(0);
  expect(await clearSpace('g',f.root)).toBe(0);expect(await clearSpace('g',f.root)).toBe(0);
  expect(await pending(paths.g!)).toBe(1);expect(await pending(paths.direct!)).toBe(0);
  expect(await clearSpace('--direct',f.root)).toBe(0);expect(await pending(paths.direct!)).toBe(1);
  expect(readLedger(ledger)).toEqual(before);expect(await readFile(join(workspace,'keep.txt'),'utf8')).toBe('material');
  expect(await readFile(join(tmp,'keep.txt'),'utf8')).toBe('draft');
  // Clearing everything again registers nothing twice.
  expect(await clearAllSpaces(f.root)).toBe(0);
  expect([await pending(paths.g!),await pending(paths.direct!)]).toEqual([1,1]);
  expect(readLedger(ledger)).toEqual(before);
 }finally{ledger.close();await f.cleanup();}
},20000);

test('history never imports unrecognized files, refuses a database of another space, and handles an empty root',async()=>{
 const f=await tempFixture('history-current-gate-');
 try{
  expect(await clearAllSpaces(f.root)).toBe(0);
  expect(await clearSpace('--direct',f.root)).toBe(1);
  const stray=join(f.root,'conversations','groups','g','session.jsonl');
  await mkdir(dirname(stray),{recursive:true});await writeFile(stray,'unrecognized data');
  expect(await collect(f.root)).toEqual([]);expect(await readFile(stray,'utf8')).toBe('unrecognized data');
  const {models}=fauxModels();const opened=await openGroupHarness(databaseOf(f.root,'g'),models,{group:'other'});await opened.close();
  expect(await clearSpace('g',f.root)).toBe(1);expect(await clearSpace('missing',f.root)).toBe(1);
  expect(await clearAllSpaces(f.root)).toBe(1);
 }finally{await f.cleanup();}
});
