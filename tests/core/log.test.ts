import { describe, expect, test } from "bun:test";
import { sanitizeLogMessage } from "../../src/core/log.ts";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_BACKUP_COUNT, LOG_FILE, LOG_MAX_BYTES } from "../../src/core/config.ts";
import { tempFixture } from "../helpers/temp.ts";

describe("log sanitization", () => {
  test("keeps external values on one terminal-safe line", () => {
    expect(sanitizeLogMessage("first\nsecond\r\t\u001b[31m\u2028last")).toBe(
      "first\\nsecond\\r\\t\\u001b[31m\\u2028last"
    );
  });
});

test("log rotation retains only the configured backups without accumulating an archive", async () => {
  const fixture = await tempFixture("log-retention-");
  const module = fileURLToPath(new URL("../../src/core/log.ts", import.meta.url));
  const script = join(fixture.root, "rotate.ts");
  await writeFile(script, `import {log} from ${JSON.stringify(module)};
    import {writeFileSync} from 'node:fs';
    for(let i=0;i<${LOG_BACKUP_COUNT + 3};i++) {
      writeFileSync(${JSON.stringify(join("logs", LOG_FILE))},Buffer.alloc(${LOG_MAX_BYTES},65+i));
      log.info('rotation '+i);
    }`);
  const child = Bun.spawn([process.execPath, script], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    const names = await readdir(join(fixture.root, "logs"));
    expect(names.sort()).toEqual([LOG_FILE, ...Array.from({ length: LOG_BACKUP_COUNT }, (_, i) => `${LOG_FILE}.${i + 1}`)].sort());
    let bytes = 0;
    for (const name of names) bytes += (await stat(join(fixture.root, "logs", name))).size;
    expect(bytes).toBeLessThanOrEqual(LOG_MAX_BYTES * (LOG_BACKUP_COUNT + 1));
    expect(await readFile(join(fixture.root, "logs", LOG_FILE), "utf8")).toContain(`rotation ${LOG_BACKUP_COUNT + 2}`);
    expect(existsSync(join(fixture.root, "agents/rm"))).toBe(false);
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 20000);
