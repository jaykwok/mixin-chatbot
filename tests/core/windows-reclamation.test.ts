import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { removeWindowsTree } from "../../src/core/held-directory.ts";
import { reclamationEvidence } from "../../src/core/reclamation-files.ts";
import { reclaimWindows } from "../../src/maintenance/windows.ts";
import { tempFixture } from "../helpers/temp.ts";

const windows = process.platform === "win32" ? test : test.skip;
windows("offline Windows reclamation verifies contents and persists completion", async () => {
  const f = await tempFixture("windows-reclamation-");
  try {
    const path = join(f.root, "result"), journal = join(f.root, "plans"), id = randomUUID() + "-0";
    await mkdir(join(path, "nested"), { recursive: true }); await mkdir(journal);
    await writeFile(join(path, "nested/file"), "reviewed");
    const evidence = await reclamationEvidence(path);
    await reclaimWindows(path, evidence, journal, id);
    expect(await lstat(path).catch(error => error.code)).toBe("ENOENT");
    expect(JSON.parse(await readFile(join(journal, id + ".json"), "utf8")).phase).toBe("removed");
    await reclaimWindows(path, evidence, journal, id);
  } finally { await f.cleanup(); }
});

windows("Windows deletion holds every child before authorization and rejects replacements on resume", async () => {
  const f = await tempFixture("windows-reclamation-swap-");
  try {
    const path = join(f.root, "result"); await mkdir(path); await writeFile(join(path, "keep"), "old");
    const identity = await lstat(path, { bigint: true });
    let entries: Parameters<Parameters<typeof removeWindowsTree>[2]>[0] = [];
    let blocked = false;
    try { await removeWindowsTree(path, identity, async manifest => {
      entries = manifest;
      try { await rename(join(path, "keep"), join(path, "moved")); }
      catch { blocked = true; }
      throw new Error("synthetic crash before deletion");
    }); } catch (error) { expect(String(error)).toContain("synthetic crash"); }
    expect(blocked).toBe(true); expect(await readFile(join(path, "keep"), "utf8")).toBe("old");
    await rename(join(path, "keep"), join(path, "original"));
    await writeFile(join(path, "keep"), "replacement");
    let failure: unknown;
    try { await removeWindowsTree(path, identity, async () => {}, entries); } catch (error) { failure = error; }
    expect(String(failure)).toContain("换入实体");
    expect(await readFile(join(path, "keep"), "utf8")).toBe("replacement");
    expect(await readFile(join(path, "original"), "utf8")).toBe("old");
  } finally { await f.cleanup(); }
});
