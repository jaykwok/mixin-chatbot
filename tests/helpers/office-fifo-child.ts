// Run the real FIFO cleanup in a child so a regression cannot hang the test runner.
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOfficeProfile, recoverOfficeProfiles } from "../../src/agent/office-profiles.ts";

const root = process.argv[2]!, mode = process.argv[3]!;
if (process.platform !== "linux" || !["close", "recover"].includes(mode)) throw new Error("Linux FIFO cleanup mode required");
const profile = await createOfficeProfile(root), marker = join(profile.path, ".mixin-office-owner.json");
const journal = join(root, ".office-jobs"), receipt = join(journal, (await readdir(journal))[0]!);
let proof = await readFile(marker, "utf8"), fifo = false;
const cleanup = () => mode === "close" ? profile.close() : recoverOfficeProfiles(root);
try {
  if (mode === "recover") {
    proof = JSON.stringify({ ...JSON.parse(proof), owner: "0".repeat(32), pid: 2147483647 });
    await writeFile(receipt, proof);
  }
  await rm(marker);
  const mkfifo = Bun.spawn(["mkfifo", marker], { stdout: "ignore", stderr: "pipe" });
  if (await mkfifo.exited !== 0) throw new Error(await new Response(mkfifo.stderr).text());
  fifo = true;
  await writeFile(join(root, "ready.json"), JSON.stringify({ path: profile.path, isFIFO: (await lstat(marker)).isFIFO() }));
  const beforeFds = (await readdir("/proc/self/fd")).length, started = performance.now(), errors: string[] = [];
  // Never open a write end. Repeated rejection must also release every held descriptor.
  for (let i = 0; i < 3; i++) {
    try { await cleanup(); errors.push("unexpected success"); }
    catch (error) { errors.push(String(error)); }
  }
  const elapsedMs = performance.now() - started, afterFds = (await readdir("/proc/self/fd")).length;
  const receiptPreserved = await readFile(receipt, "utf8") === proof;
  const stillFIFO = (await lstat(marker)).isFIFO();
  await rm(marker); fifo = false; await writeFile(marker, proof);
  const restoredResult = await cleanup();
  const profileGone = await lstat(profile.path).then(() => false, error => { if (error.code !== "ENOENT") throw error; return true; });
  await writeFile(join(root, "result.json"), JSON.stringify({ errors, elapsedMs, beforeFds, afterFds, receiptPreserved,
    stillFIFO, restoredResult, profileGone, remainingReceipts: await readdir(journal) }));
} finally {
  if (fifo) { await rm(marker); await writeFile(marker, proof); }
  await cleanup();
  await rm(profile.path, { recursive: true, force: true }); // This helper created and recorded this synthetic profile.
}
