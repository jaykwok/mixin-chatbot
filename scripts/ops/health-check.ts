import { readFile } from "node:fs/promises";
import { matchesInstance } from "../../src/core/health.ts";

// No SDK initialization, model calls or credentials in output.
try {
  const expected = JSON.parse(await readFile("data/state/instance.json", "utf8"));
  const port = Number(process.env.BOT_PORT || expected.port);
  let body: unknown;
  if (process.argv.includes("--stdin")) body = await Bun.stdin.json();
  else {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500), redirect: "error" });
    if (!response.ok) throw new Error("not ready");
    body = await response.json();
  }
  if (!matchesInstance(body, expected, port) || body.status !== "ready") process.exitCode = 1;
  else if (body.verificationOnly && !process.argv.includes("--allow-verification")) {
    console.error("实例处于只验证模式，尚未处理消息；请继续升级完成提交");
    process.exitCode = 3;
  } else process.exitCode = 0;
} catch { process.exitCode = 1; }
