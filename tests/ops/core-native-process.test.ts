import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runNative, nativePayload } from "../../scripts/ops/core/native-process.ts";
import { WindowsPlatform } from "../../scripts/ops/core/windows-host.ts";
import { tempFixture } from "../helpers/temp.ts";

test("原生适配同时排空大 stderr 与协议 stdout，跨字节块中文完整", async () => {
  const f = await tempFixture("native-utf8-");
  try {
    const script = join(f.root, "output.ts");
    await writeFile(script, `const line=Buffer.from('中文日志\\n');
for(let i=0;i<40000;i++){ await Bun.write(Bun.stderr,line); }
const text=Buffer.from(JSON.stringify({protocol:'mixin-platform',version:1,action:'inspect',ok:true,value:'中文结果'}));
for(const byte of text){process.stdout.write(Buffer.from([byte])); await Bun.sleep(1);}`);
    let stderr = "";
    const result = await runNative({ command: process.execPath, args: ["--no-env-file", script], cwd: f.root, protocol: true }, (text, stream) => {
      expect(stream).toBe("stderr"); stderr += text;
    });
    expect(nativePayload(result, "inspect")).toBe("中文结果");
    expect(stderr).toBe("中文日志\n".repeat(40000));
    expect(() => nativePayload({ ...result, code: 1 }, "inspect")).toThrow("退出码 1");
    expect(() => nativePayload(result, "stop")).toThrow("动作不符");
    expect(() => nativePayload({ code: 0, stdout: result.stdout.slice(0, -1) }, "inspect")).toThrow("完整 JSON");
  } finally { await f.cleanup(); }
}, 30_000);

test("原生适配取消后确认子进程树已回收，再允许恢复步骤", async () => {
  const f = await tempFixture("native-cancel-");
  try {
    const script = join(f.root, "wait.ts");
    await writeFile(script, `console.log('READY:'+process.pid); setInterval(()=>{},1000);`);
    const abort = new AbortController(); let pid = 0, lines = "";
    await expect(runNative({ command: process.execPath, args: ["--no-env-file", script], cwd: f.root, signal: abort.signal }, text => {
      lines += text; const match = lines.match(/READY:(\d+)/); if (match) { pid = Number(match[1]); abort.abort(); }
    })).rejects.toThrow();
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await f.cleanup(); }
}, 20_000);

test("Windows 平台适配参数不经表达式求值，未知或破损协议不放行", async () => {
  const seen: string[][] = [];
  const adapter = new WindowsPlatform("D:\\含 空格\\项目", "D:\\source", async command => {
    seen.push(command.args);
    const request = JSON.parse(Buffer.from(command.args.at(-1)!, "base64").toString("utf8"));
    expect(request.task).toBe("mixin-chatbot");
    return { code: 0, stdout: JSON.stringify({ protocol: "mixin-platform", version: 1, action: request.action, ok: true,
      value: request.action === "inspect" ? { identity: "a".repeat(64), state: "stopped", rawState: "Ready", owned: true } : null }) };
  });
  expect((await adapter.inspect()).state).toBe("stopped");
  await adapter.start("a".repeat(64)); await adapter.stop("a".repeat(64));
  expect(seen.every(args => args.includes("-File") && args.includes("-RequestBase64") && !args.includes("-Command"))).toBe(true);
  await expect(new WindowsPlatform(".", ".", async () => ({ code: 0, stdout: "{}" })).inspect()).rejects.toThrow();
});
