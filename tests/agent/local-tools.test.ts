import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createMemberEnv } from '../../src/durable/member-env.ts';
import { tempFixture } from '../helpers/temp.ts';

test('per-call native environments keep cwd independent and binary reads bounded while preserving read-only resources',async()=>{
 const f=await tempFixture('native-member-env-');
 try{
  const workspace=join(f.root,'workspace'),alice=join(f.root,'alice'),bob=join(f.root,'bob');
  for(const path of [workspace,alice,bob])await mkdir(path,{recursive:true});
  await writeFile(join(workspace,'material.txt'),'reference');await writeFile(join(bob,'private.txt'),'bob');
  const build=(tempDir:string,phone:string)=>createMemberEnv({workspaceDir:workspace,tempDir,phone,groupId:'g',venvDir:join(f.root,'venv'),materialsIndexPath:join(f.root,'index/materials.md')});
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
