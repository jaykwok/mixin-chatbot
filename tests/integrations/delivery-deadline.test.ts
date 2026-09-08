import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

test("an oversized Retry-After cannot extend the total delivery deadline", async () => {
  const fixture = await tempFixture("im-deadline-");
  const script = join(fixture.root, "deadline.ts");
  await writeFile(script, `import assert from 'node:assert/strict';
    import {sendText} from ${JSON.stringify(fileURLToPath(new URL("../../src/integrations/im.ts", import.meta.url)))};
    let calls=0;
    globalThis.fetch=async()=>{ calls++; return calls===1 ? new Response('limited',{status:429,headers:{'Retry-After':'99999999999'}}) : Response.json({ok:true,code:200}); };
    const start=Date.now();
    const error=await sendText('deadline','group','user','https://im.zdxlz.com/im-external/v1/webhook/send?key=deadline').catch(e=>e);
    assert.ok(error instanceof Error); assert.ok(Date.now()-start<2500); assert.equal(calls,1);
    assert.equal(await sendText('next','group','user','https://im.zdxlz.com/im-external/v1/webhook/send?key=next'),true);
    console.log('DEADLINE_VERIFIED');
  `);
  const child = Bun.spawn([process.execPath, script], { cwd: fixture.root,
    env: { ...process.env, BOT_DELIVERY_TIMEOUT_SECONDS: "1" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 7000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + stderr).toBe(0); expect(stdout).toContain("DEADLINE_VERIFIED");
  } finally { clearTimeout(timeout); child.kill(); await child.exited; await fixture.cleanup(); }
}, 10000);
