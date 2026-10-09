import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

// Scripts calling the document tools are covered on the Durable engine (tests/durable/codemode.test.ts, tests/durable/registry.test.ts).
const cases = [
  { kind: "protocol", script: new URL("../helpers/document-protocol-harness.ts", import.meta.url), marker: "DOCUMENT_PROTOCOL_PASSED" },
  { kind: "office-profile", script: new URL("../helpers/document-office-harness.ts", import.meta.url), marker: "DOCUMENT_OFFICE_PROFILE_PASSED" },
];
test.each(cases)("document tool results follow one structured protocol ($kind)", async ({ kind, script, marker }) => {
  const fixture = await tempFixture("document-" + kind + "-");
  const child = Bun.spawn([process.execPath, fileURLToPath(script)], {
    cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups", BOT_DEPLOY_BACKUP_ID: undefined },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 40000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0); expect(out).toContain(marker);
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 45000);
