// Minimal synthetic protocol server. No network or production files.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.argv[2] === "descendant") {
  writeFileSync(process.argv[3]!, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  if (process.argv[2] === "spawn") spawn(process.execPath, [import.meta.path, "descendant", process.argv[3]!], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, serverInfo: { name: "synthetic", version: "1" }, capabilities: { tools: {} } };
    else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "synthetic echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
    else if (request.method === "tools/call") result = { content: [{ type: "text", text: JSON.stringify({ args: request.params.arguments,
      group: process.env.MIXIN_GROUP_ID, phone: process.env.MIXIN_MEMBER_PHONE, cwd: process.cwd(), secret: process.env.MIXIN_TEST_AMBIENT_SECRET ?? null }) }] };
    else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method" } }) + "\n"); return; }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  });
  lines.once("close", () => process.exit(0));
}
