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
  process.exitCode = matchesInstance(body, expected, port) && body.status === "ready" ? 0 : 1;
} catch { process.exitCode = 1; }
