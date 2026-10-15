import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const CHILD_TIMEOUT_MS = 20_000;
// Leave time after the watchdog for exit, pipe draining and fixture cleanup.
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 10_000;

async function capture(stream: ReadableStream<Uint8Array>, append: (text: string) => void) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
  append(decoder.decode());
}

test.each(["write", "edit"])("%s path keys match the installed Pi resolver in an isolated home", async name => {
  const files = await tempFixture("pi-path-");
  const started = performance.now();
  // Pi's file mutation queue calls realpath before operations: probe home paths in a child with an isolated home.
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/tool-path-harness.ts", import.meta.url)), name], {
    cwd: files.root, env: { ...process.env, HOME: files.root, USERPROFILE: files.root },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  let out = "", err = "", timedOut = false;
  const diagnostics = (code: number | null = child.exitCode) => `[tool-path ${name}] timedOut=${timedOut} elapsedMs=${Math.round(performance.now() - started)}`
    + ` pid=${child.pid} exitCode=${code}\n--- stdout ---\n${out || "(empty)"}\n--- stderr ---\n${err || "(empty)"}`;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(diagnostics());
    child.kill();
  }, CHILD_TIMEOUT_MS);
  try {
    const [code] = await Promise.all([
      child.exited.then(code => { clearTimeout(timer); return code; }),
      capture(child.stdout, text => { out += text; }),
      capture(child.stderr, text => { err += text; }),
    ]);
    // Bun can leave child.exitCode null after a signal; use the resolved exit code.
    const detail = diagnostics(code);
    expect(timedOut, detail).toBe(false);
    expect(code, detail).toBe(0);
    expect(out, detail).toContain("PATHS_PASSED");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await files.cleanup(); }
}, TEST_TIMEOUT_MS);
