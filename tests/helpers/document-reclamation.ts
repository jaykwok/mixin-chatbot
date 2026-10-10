import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Verify the cleanup contract without turning an unproven shared directory into removal authority. */
export async function checkDocumentReclamation(job: string, succeeded?: boolean, isolated = false) {
  const files = await readdir(job);
  if (process.platform === "linux" && !isolated) {
    const receipt = JSON.parse(await readFile(join(job, ".reclamation.json"), "utf8"));
    assert.equal(receipt.version, 1); assert.equal(receipt.status, "deferred");
    assert.equal(receipt.reason, "shared-parent-writers-not-isolated");
    assert.equal(typeof receipt.succeeded, "boolean");
    if (succeeded !== undefined) assert.equal(receipt.succeeded, succeeded);
    assert.ok(Number.isFinite(receipt.at));
    assert.ok((await stat(join(job, ".work"))).isDirectory(), "deferred scratch must remain intact");
  } else assert.ok(!files.includes(".work"), "completed isolated/Windows job retained its scratch");
  assert.ok(files.every(file => !file.endsWith(".request.json") && !file.startsWith("office-")), "intermediates escaped scratch");
}

/** Only this fixture's durable receipts identify its retained profiles; existing system-temp entries are never adopted. */
export async function retainedOfficeProfiles(tempDirs: string[], systemTemp: string): Promise<string[]> {
  const retained: string[] = [];
  for (const tempDir of tempDirs) {
    const root = join(tempDir, ".office-jobs"), files = await readdir(root);
    if (process.platform !== "linux") { assert.deepEqual(files, []); continue; }
    const receipts = files.filter(name => !name.endsWith(".deferred.json"));
    assert.equal(files.length, receipts.length * 2, "every retained profile needs ownership and deferred receipts");
    for (const file of receipts) {
      assert.match(file, /^[a-f0-9]{16}\.json$/);
      const receipt = JSON.parse(await readFile(join(root, file), "utf8")), name = `mixin-office-${receipt.id}`;
      assert.equal(file, receipt.id + ".json"); assert.equal(receipt.version, 1); assert.equal(receipt.pid, process.pid);
      assert.equal(receipt.tempRoot, tempDir); assert.equal(receipt.systemRoot, systemTemp);
      const marker = JSON.parse(await readFile(join(systemTemp, name, ".mixin-office-owner.json"), "utf8"));
      assert.deepEqual(marker, receipt, "retained profile must keep its original ownership marker");
      const deferred = JSON.parse(await readFile(join(root, receipt.id + ".deferred.json"), "utf8"));
      assert.equal(deferred.id, receipt.id); assert.equal(deferred.version, 1);
      assert.equal(deferred.result.name, name); assert.equal(deferred.result.status, "deferred");
      assert.equal(deferred.result.reason, "exclusive-writers-not-proven");
      const entity = await stat(join(systemTemp, name), { bigint: true });
      assert.deepEqual(deferred.result.identity, { dev: String(entity.dev), ino: String(entity.ino) });
      assert.ok(Number.isFinite(deferred.attemptedAt)); retained.push(name);
    }
  }
  return retained.sort();
}
