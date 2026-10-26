import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempFixture } from '../helpers/temp.ts';
import { publishJson } from '../../scripts/lib/atomic-file.ts';
import { validateCurrentData } from '../../src/core/data-validation.ts';
import { applicationBinding } from '../../src/core/data-version.ts';
import { APP_VERSION, DATA_VERSION } from '../../src/core/version.ts';
import { readRelayIndex } from '../../src/integrations/relay-index.ts';
const s3={provider:'s3',endpoint:'https://s3.example.test',region:'test',bucket:'bucket',accessKeyId:'test',secretAccessKey:'test'};
async function fixture(){
 const f=await tempFixture('current-relay-validation-');
 await publishJson(join(f.root,'data/config/app-bot.json'),{environment:'production',appId:'test-app',appSecret:'test-only-secret'});
 await publishJson(join(f.root,'data/config/models.json'),{providers:{fixture:{baseUrl:'https://fixture.invalid/v1',api:'openai-completions',apiKey:'fixture-key',models:[{id:'test',name:'test',reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}});
 await publishJson(join(f.root,'data/runtime/pi/settings.json'),{defaultProvider:'fixture',defaultModel:'test'});
 // A deployed instance: the relay ledger is data, which is only read under a deployment record of this application.
 await publishJson(join(f.root,'data/state/data-version.json'),{dataVersion:DATA_VERSION,appVersion:APP_VERSION,build:'',transaction:'deploy-relay-test',application:applicationBinding({environment:'production',appId:'test-app'})});
 return {...f,config:join(f.root,'data/config/relay.json'),ledger:join(f.root,'data/state/relay.sqlite')};
}
test('current validation rejects invalid relay configuration without rewriting it',async()=>{
 const f=await fixture();try{await publishJson(f.config,{...s3,provider:'ftp'});const before=await readFile(f.config);
 await expect(validateCurrentData(f.root)).rejects.toThrow('provider 必须是 s3');expect(await readFile(f.config)).toEqual(before);
 }finally{await f.cleanup();}
});
test('current validation rejects invalid relay ledger and reads a valid ledger without changing it',async()=>{
 const f=await fixture();try{await publishJson(f.config,s3);const db=new Database(f.ledger);
 db.exec('CREATE TABLE objects (key TEXT PRIMARY KEY, url TEXT, name TEXT, size INTEGER, at TEXT, state TEXT)');db.close();
 const before=await readFile(f.ledger);await expect(validateCurrentData(f.root)).rejects.toThrow('外链账本结构无效');expect(await readFile(f.ledger)).toEqual(before);
 const valid=new Database(f.ledger);valid.exec('DROP TABLE objects; CREATE TABLE objects (key TEXT PRIMARY KEY, url TEXT, name TEXT, size INTEGER, at TEXT, state TEXT, expiresAt TEXT, deleteAfter TEXT)');valid.close();
 const bytes=await readFile(f.ledger);expect(readRelayIndex(f.ledger)).toEqual([]);await validateCurrentData(f.root);expect(await readFile(f.ledger)).toEqual(bytes);
 }finally{await f.cleanup();}
});
