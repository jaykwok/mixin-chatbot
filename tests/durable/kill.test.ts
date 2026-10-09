import { afterAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GroupHarnesses, groupDatabasePath } from "../../src/durable/groups.ts";
import { IdentityDoc, MemberDirectory } from "../../src/durable/identity.ts";
import { openGroupDatabase } from "../../src/durable/sqlite.ts";
import { fauxModels, harnessOptions } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-kill-");
afterAll(() => fixture.cleanup());
const resolve = (specifier: string) => JSON.stringify(import.meta.resolve(specifier));

// The child commits member conversations through the project wiring and acknowledges each commit after it resolves.
const child = `
import { BACKGROUND_CONTEXT } from ${resolve("@earendil-works/chord/context")};
import { createModels } from ${resolve("@earendil-works/pi-ai")};
import { fauxProvider } from ${resolve("@earendil-works/pi-ai/providers/faux")};
import { createRegistry } from ${resolve("@earendil-works/pi-durable")};
import { GroupHarnesses } from ${resolve("../../src/durable/groups.ts")};
import { memberConversation } from ${resolve("../../src/durable/identity.ts")};
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
const groups = new GroupHarnesses({ root: process.argv[2], harnessOptions: () => ({ models, registry: createRegistry() }) });
const { harness } = await groups.acquire("kill-group");
for (let i = 1; ; i++) {
  await memberConversation(harness, "kill-group", "member-" + i, { model }, BACKGROUND_CONTEXT);
  process.stdout.write("ack " + i + "\\n");
}
`;

test("a force-killed writer leaves an intact database with every acknowledged commit", async () => {
  const script = join(fixture.root, "writer.ts");
  await writeFile(script, child);
  const root = join(fixture.root, "groups");
  const process_ = Bun.spawn([process.execPath, script, root], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  let acked = 0;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = process_.stdout.getReader();
  const target = 40 + Math.floor(Math.random() * 40);
  while (acked < target) {
    const { value, done } = await reader.read();
    if (done) throw new Error("writer exited early: " + await new Response(process_.stderr).text());
    buffer += decoder.decode(value, { stream: true });
    for (const match of buffer.matchAll(/^ack (\d+)$/gm)) acked = Math.max(acked, Number(match[1]));
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  }
  process_.kill("SIGKILL");
  await process_.exited;
  reader.releaseLock();
  expect(process_.signalCode ?? process_.exitCode).not.toBe(0);

  const path = groupDatabasePath(root, "kill-group");
  const db = await openGroupDatabase(path);
  try { expect(await db.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" }); }
  finally { await db.close(); }

  const groups = new GroupHarnesses({ root, harnessOptions: harnessOptions(fauxModels().models) });
  try {
    const { harness, release } = await groups.acquire("kill-group");
    for (let i = 1; i <= acked; i++) {
      const member = await harness.snapshot(MemberDirectory, `member-${i}`, BACKGROUND_CONTEXT);
      expect(member?.conversationId).toBeGreaterThan(0);
      expect(await harness.snapshot(IdentityDoc, member!.conversationId as never, BACKGROUND_CONTEXT))
        .toEqual({ groupId: "kill-group", phone: `member-${i}`, version: 1 });
    }
    console.log(`force kill after ${acked} acknowledged commits: integrity ok, all present`);
    release();
  } finally { await groups.closeAll(); }
}, 60_000);
