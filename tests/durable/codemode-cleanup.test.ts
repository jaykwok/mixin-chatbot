import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeCodemodeResults } from "../../src/durable/codemode/results.ts";
import { junctionInPlace } from "../helpers/junction-in-place.ts";
import { tempFixture } from "../helpers/temp.ts";

const name = "42-synthetic";
const link = (target: string, path: string) => symlink(target, path, process.platform === "win32" ? "junction" : "dir");

for (const level of ["parent", "call"] as const) for (const replacement of ["link", "directory"] as const) {
  test(`cleanup holds the ${level} across expiry when replaced by a ${replacement}`, async () => {
    const fixture = await tempFixture("cleanup-swap-");
    try {
      const member = join(fixture.root, "member"), root = join(member, "codemode"), call = join(root, name);
      const outside = join(fixture.root, "unrelated"), moved = join(fixture.root, "moved");
      const attacked = level === "parent" ? root : call;
      const sentinel = join(outside, ...(level === "parent" ? [name] : []), "keep.txt");
      await mkdir(call, { recursive: true });
      await mkdir(join(sentinel, ".."), { recursive: true });
      await writeFile(join(call, "index.txt"), "owned result"); await writeFile(sentinel, "keep");
      let swapped = false;
      const removed = await removeCodemodeResults(member, Infinity, {
        registered: new Set([name]), protected: new Set(),
        expire: async () => {
          try { await rename(attacked, moved); }
          catch (error) {
            // Holding an NTFS directory prevents replacement. The attempted attack is still exercised.
            if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
            return;
          }
          swapped = true;
          if (replacement === "link") await link(outside, attacked);
          else {
            const other = join(attacked, ...(level === "parent" ? [name] : []));
            await mkdir(other, { recursive: true }); await writeFile(join(other, "keep.txt"), "replacement");
          }
        },
      });
      expect(removed).toEqual(process.platform === "linux" ? [] : [name]); expect(await readFile(sentinel, "utf8")).toBe("keep");
      expect(swapped).toBe(process.platform === "linux");
      if (swapped && replacement === "directory") {
        expect(await readFile(join(attacked, ...(level === "parent" ? [name] : []), "keep.txt"), "utf8")).toBe("replacement");
      }
      const original = swapped ? join(moved, ...(level === "parent" ? [name] : [])) : call;
      expect(existsSync(join(original, "index.txt"))).toBe(process.platform === "linux");
    } finally { await fixture.cleanup(); }
  });
}

test("cleanup removes nested owned files and links themselves, preserves unregistered/protected calls and linked roots", async () => {
  const fixture = await tempFixture("cleanup-policy-");
  try {
    const member = join(fixture.root, "member"), root = join(member, "codemode"), outside = join(fixture.root, "unrelated");
    const call = join(root, name), sentinel = join(outside, "keep.txt");
    expect(await removeCodemodeResults(member, Infinity)).toEqual([]); expect(existsSync(member)).toBe(false);
    for (const path of [join(call, "nested", "deeper"), join(root, "43-protected"), join(root, "44-unknown"), outside]) await mkdir(path, { recursive: true });
    await writeFile(sentinel, "keep"); await writeFile(join(call, "nested", "deeper", "owned.txt"), "owned");
    await link(outside, join(call, "nested", "link")); await link(outside, join(root, "45-link"));
    const expired: string[] = [];
    expect(await removeCodemodeResults(member, Infinity, {
      registered: new Set([name, "43-protected", "45-link"]), protected: new Set(["43-protected"]),
      expire: async (names) => { expired.push(...names); },
    })).toEqual(process.platform === "linux" ? [] : [name]);
    expect(expired).toEqual([name]); expect(existsSync(call)).toBe(process.platform === "linux");
    if (process.platform === "linux") expect(await readFile(join(call, "nested/deeper/owned.txt"), "utf8")).toBe("owned");
    for (const remaining of ["43-protected", "44-unknown", "45-link"]) expect(existsSync(join(root, remaining))).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    await rename(root, join(member, "old")); await link(outside, root);
    expect(await removeCodemodeResults(member, Infinity)).toEqual([]); expect(await readFile(sentinel, "utf8")).toBe("keep");
  } finally { await fixture.cleanup(); }
});

test.skipIf(process.platform !== "linux")("missing shared names keep logical expiry and a pending receipt without claiming physical removal", async () => {
  const fixture = await tempFixture("cleanup-missing-");
  try {
    const expired: string[] = [], records: { name: string; status: string; reason?: string }[] = [];
    expect(await removeCodemodeResults(fixture.root, Infinity, {
      registered: new Set([name, "43-protected"]), protected: new Set(["43-protected"]),
      expire: async names => { expired.push(...names); }, record: async rows => { records.push(...rows); },
    })).toEqual([]);
    expect(expired).toEqual([name]);
    expect(records).toEqual([{ name, status: "deferred", reason: "shared-name-missing-or-unavailable-is-not-removal-proof" }]);
  } finally { await fixture.cleanup(); }
});

test("failed expiry leaves all bytes intact and releases handles for a retry", async () => {
  const fixture = await tempFixture("cleanup-retry-");
  try {
    const call = join(fixture.root, "codemode", name); await mkdir(call, { recursive: true });
    await writeFile(join(call, "index.txt"), "owned");
    await expect(removeCodemodeResults(fixture.root, Infinity, {
      registered: new Set([name]), protected: new Set(), expire: async () => { throw new Error("receipt failed"); },
    })).rejects.toThrow("receipt failed");
    expect(await readFile(join(call, "index.txt"), "utf8")).toBe("owned");
    expect(await removeCodemodeResults(fixture.root, Infinity)).toEqual(process.platform === "linux" ? [] : [name]);
  } finally { await fixture.cleanup(); }
});

test.skipIf(process.platform !== "win32")("cleanup refuses an empty held call made a junction in place during expiry", async () => {
  const fixture = await tempFixture("cleanup-junction-");
  try {
    const call = join(fixture.root, "codemode", name), outside = join(fixture.root, "unrelated");
    await mkdir(call, { recursive: true }); await mkdir(outside);
    await writeFile(join(call, "index.txt"), "owned"); await writeFile(join(outside, "keep.txt"), "keep");
    await expect(removeCodemodeResults(fixture.root, Infinity, {
      registered: new Set([name]), protected: new Set(), expire: async () => {
        await unlink(join(call, "index.txt"));
        expect(junctionInPlace(call, outside)).toEqual({ set: true });
      },
    })).rejects.toThrow("its directory was made a link");
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await removeCodemodeResults(fixture.root, Infinity)).toEqual([]);
  } finally { await fixture.cleanup(); }
});
