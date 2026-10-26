import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { existsSync } from 'node:fs';
import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { createMemberEnv, memberShell } from '../../src/durable/member-env.ts';
import { tempFixture } from '../helpers/temp.ts';
import { groupScope } from '../../src/core/layout.ts';

test('string commands run with argv shells only; the stdin-only WSL launcher is refused with what to install',()=>{
 expect(memberShell({shell:'/bin/bash',args:['-c']})).toEqual({shell:'/bin/bash',args:['-c']});
 expect(memberShell({shell:'C:\\Program Files\\Git\\bin\\bash.exe',args:['-c'],commandTransport:'argv'})).toEqual({shell:'C:\\Program Files\\Git\\bin\\bash.exe',args:['-c']});
 expect(()=>memberShell({shell:'C:\\Windows\\System32\\bash.exe',args:['-s'],commandTransport:'stdin'})).toThrow('WSL 启动器');
});

const system32Bash=join(process.env.SystemRoot??'C:\\Windows','System32','bash.exe');
test.skipIf(process.platform!=='win32'||!existsSync(system32Bash))('Pi 1.4.0 classifies the System32 launcher as stdin-only, and the member shell refuses it',()=>{
 // Upstream's own classification of the real launcher path (no PATH search, no environment change).
 expect(getShellConfig(system32Bash).commandTransport).toBe('stdin');
 expect(()=>memberShell(getShellConfig(system32Bash))).toThrow('WSL 启动器');
});

// The app execution alias that starts wsl.exe: Pi 1.4.0 accepts it as an ordinary argv shell, the member shell does not.
test.skipIf(process.platform!=='win32')('the WindowsApps bash alias is refused like the legacy launcher',()=>{
 expect(()=>memberShell({shell:'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',args:['-c']})).toThrow('WSL 启动器');
 expect(memberShell({shell:'C:\\tools\\WindowsAppsKit\\bash.exe',args:['-c']}).shell).toBe('C:\\tools\\WindowsAppsKit\\bash.exe');
 const alias=join(process.env.LOCALAPPDATA??'','Microsoft','WindowsApps','bash.exe');
 if(!process.env.LOCALAPPDATA||!existsSync(alias))return;
 expect(getShellConfig(alias)).toEqual({shell:alias,args:['-c']});
 expect(()=>memberShell(getShellConfig(alias))).toThrow('WSL 启动器');
});

test('per-call native environments keep cwd independent and binary reads bounded while preserving read-only resources',async()=>{
 const f=await tempFixture('native-member-env-');
 try{
  const workspace=join(f.root,'workspace'),alice=join(f.root,'alice'),bob=join(f.root,'bob');
  for(const path of [workspace,alice,bob])await mkdir(path,{recursive:true});
  await writeFile(join(workspace,'material.txt'),'reference');await writeFile(join(bob,'private.txt'),'bob');
  const build=(tempDir:string,phone:string)=>createMemberEnv({workspaceDir:workspace,tempDir,phone,scope:groupScope('g'),venvDir:join(f.root,'venv'),materialsIndexPath:join(f.root,'index/materials.md')});
  const a=await build(alice,'alice'),b=await build(bob,'bob');
  expect(a).not.toBe(b);expect(a.cwd).toBe(workspace);
  expect((await a.readTextFile(join(workspace,'material.txt'),context))).toEqual({ok:true,value:'reference'});
  expect((await a.readTextFile(join(bob,'private.txt'),context)).ok).toBe(false);
  expect((await a.writeFile(join(workspace,'material.txt'),'changed',context)).ok).toBe(false);
  expect((await a.writeFile(join(alice,'sub/draft.txt'),'draft',context)).ok).toBe(true);
  const reader=await a.openBinaryReader(join(workspace,'material.txt'),undefined,context);expect(reader.ok).toBe(true);
  if(reader.ok){try{expect((await reader.value.read(0,64*1024*1024,context)).ok).toBe(false);expect((await reader.value.read(0,9,context))).toEqual({ok:true,value:Buffer.from('reference')});}finally{await reader.value.close(context);}}
 }finally{await f.cleanup();}
});
