import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFile, rename } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { ingestConversationRecords, openStatsLedger, openExistingStatsLedger, readLedger } from '../../src/agent/stats-ledger.ts';
import { GroupDoc, memberConversation } from '../../src/durable/identity.ts';
import { projectConversation } from '../../src/durable/projection.ts';
import { collectAll } from '../../scripts/ops/stats-admin.ts';
import { summarize, trend } from '../../scripts/ops/stats-summary.ts';
import { loadStatsOverview } from '../../scripts/ops/tui/data.ts';
import { writeReport } from '../../scripts/ops/tui/report.ts';
import { fauxModels, openGroupHarness } from '../helpers/durable.ts';
import { tempFixture } from '../helpers/temp.ts';

const records = (day: string, count = 1) => Array.from({ length: count }, () => ({ type: 'message', timestamp: day,
  message: { role: 'user' } }));

test('schema 2 historical ledger survives session deletion; fresh database generations add once without changing member deduplication', async () => {
  const f = await tempFixture('ledger-generations-');
  const root = join(f.root,'groups'), path=join(f.root,'conversation.sqlite');
  const ledger=openStatsLedger(root), {faux, models, model}=fauxModels();
  let opened=await openGroupHarness(path,models,{group:'g'});
  try {
    const historical={id:'durable:g:u:1',group:'g',user:'u',identity:'durable:1'};
    ingestConversationRecords(ledger,historical,0,7,[...records('2026-09-01T12:00:00Z',2),
      {type:'message',timestamp:'2026-09-01T12:01:00Z',message:{role:'assistant',content:[{type:'toolCall',name:'send_file'}]}},
      {type:'message',timestamp:'2026-09-01T12:02:00Z',message:{role:'toolResult',toolName:'send_file',details:{fileId:'historical-attachment'},nested:{names:['read','read'],complete:false}}},
      {type:'usage',kind:'compaction',provider:'historical-provider',model:'historical-model',timestamp:'2026-09-02T12:00:00Z',
        usage:{input:100,output:20,cacheRead:30,cacheWrite:40,cost:{input:0.1,output:0.2,cacheRead:0.03,cacheWrite:0.04,total:0.37}}},
      {type:'usage',kind:'interrupted',timestamp:'2026-09-02T12:00:00Z'}]);
    ingestConversationRecords(ledger,{id:'old-other',group:'other',user:'u',identity:'old-other'},0,1,records('2026-09-02T12:00:00Z'));
    ledger.query('UPDATE sources SET projection = 1 WHERE id = ?').run(historical.id);
    const historicalRows=()=>['sources','activity','tool_counts','usage_totals'].map(table => ledger.query(`SELECT * FROM ${table} WHERE ${table==='sources'?'id':'source'} = ?`).all(historical.id));
    const before=historicalRows();
    const previousGeneration=(await opened.harness.snapshot(GroupDoc,context))!.generation;
    await opened.close();
    // Test fixture only: remove the conversation database while leaving the statistics ledger in place.
    await rename(path,path+'.archived');
    const oldSummary=summarize(await collectAll(root));
    expect(oldSummary.asks).toBe(3);expect(oldSummary.people).toBe(1);
    const historicalTotals = readLedger(ledger);
    expect(historicalTotals.activity.reduce((sum,row)=>sum+row.replies,0)).toBe(1);
    expect(historicalTotals.tools).toContainEqual(expect.objectContaining({kind:'delivered',tool:'send_file',count:1}));
    expect(historicalTotals.tools).toContainEqual(expect.objectContaining({kind:'nested',tool:'read',count:2}));
    expect(historicalTotals.usage).toContainEqual(expect.objectContaining({provider:'historical-provider',model:'historical-model',cost:0.37,input:100,cacheRead:30,cacheWrite:40}));
    const historyWindow = { since: new Date(2026,8,1).getTime(), until: new Date(2026,8,30,23,59,59).getTime() };
    const historyTrend = trend(await collectAll(root),historyWindow);
    expect((await loadStatsOverview(root)).reduce((sum,g)=>sum+g.asks,0)).toBe(3);
    const html=await writeReport({groups:await collectAll(root),window:{},detail:null,unmasked:false,
      deployment:{platform:'windows',runtime:'scheduled-task',port:1011,mode:'direct',domain:'',groupDataRoot:root,groupDataRootIsCustom:true}});
    expect(await readFile(html,'utf8')).toContain('使用统计');
    opened=await openGroupHarness(path,models,{group:'g'});
    expect((await opened.harness.snapshot(GroupDoc,context))!.generation).not.toBe(previousGeneration);
    const {conversation}=await memberConversation(opened.harness,'g','u',{model},context);
    faux.setResponses([fauxAssistantMessage('new answer')]);
    await (await conversation.submit({type:'input',content:'new question'},context)).wait(context);
    const member={groupId:'g',phone:'u',conversationId:conversation.id};
    await projectConversation(ledger,opened.harness,member,context);await projectConversation(ledger,opened.harness,member,context);
    const first=summarize(await collectAll(root));expect(first.asks).toBe(4);expect(first.people).toBe(1);
    expect(historicalRows()).toEqual(before);
    expect(trend(await collectAll(root),historyWindow)).toEqual(historyTrend);
    const totals=readLedger(ledger);await opened.close();opened=await openGroupHarness(path,models,{group:'g'});
    await projectConversation(ledger,opened.harness,member,context);expect(readLedger(ledger)).toEqual(totals);
    expect(trend(await collectAll(root),{}).reduce((sum,p)=>sum+p.asks,0)).toBe(4);
    expect(ledger.query('SELECT version FROM stats_schema').get()).toEqual({version:2});
  } finally {await opened.close();ledger.close();await f.cleanup();}
},20000);

test('current projection commits cursor and aggregates together; read-only access preserves unknown usage and refuses foreign schema', async()=>{
  const f=await tempFixture('ledger-current-');const ledger=openStatsLedger(f.root);
  try {
    const source={id:'current-generation',identity:'current-generation',group:'g',user:'u'};
    const values=[...records('2026-10-16T12:00:00Z'),{type:'usage',kind:'tool',timestamp:'2026-10-16T12:00:00Z'}];
    expect(ingestConversationRecords(ledger,source,0,2,values)).toBe(true);
    expect(ingestConversationRecords(ledger,source,0,2,values)).toBe(false);
    const snapshot=openExistingStatsLedger(f.root)!;
    try {expect(readLedger(snapshot).usage[0]).toMatchObject({requests:1,missingUsage:1,unknownCost:1});}finally{snapshot.close();}
    ledger.query('UPDATE stats_schema SET version=99').run();
    expect(()=>openExistingStatsLedger(f.root)).toThrow('保留 stats.sqlite');
  }finally{ledger.close();await f.cleanup();}
});
