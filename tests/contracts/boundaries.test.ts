import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const contracts = join(repository, "src", "contracts");

/** Every module specifier a TypeScript file names: static imports and re-exports, `import type`, and dynamic imports. */
async function specifiers(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"|^\s*import\s*"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|\brequire\(\s*"([^"]+)"\s*\)/gms)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? match[4]!);
}

/** Walk relative imports from the entry files; report each file reached and each package/builtin named on the way. */
async function graph(entries: string[]): Promise<{ files: string[]; external: string[] }> {
  const files = new Set<string>(), external = new Set<string>(), pending = [...entries];
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of await specifiers(file)) {
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
      else external.add(specifier);
    }
  }
  return { files: [...files].map(file => relative(repository, file).replaceAll("\\", "/")).sort(), external: [...external].sort() };
}

test("contracts load with Node built-ins only: no service, SQLite, FFI or scripts", async () => {
  const entries = (await readdir(contracts)).filter(name => name.endsWith(".ts")).map(name => join(contracts, name));
  expect(entries.length).toBeGreaterThan(0);
  const { files, external } = await graph(entries);
  expect(files.filter(file => !file.startsWith("src/contracts/"))).toEqual([]);
  expect(external.filter(specifier => !specifier.startsWith("node:"))).toEqual([]);
});

test("the host plan reader reaches only the contracts", async () => {
  const { files, external } = await graph([join(repository, "scripts", "lib", "tmp-plan.ts")]);
  expect(files.filter(file => file !== "scripts/lib/tmp-plan.ts" && !file.startsWith("src/contracts/"))).toEqual([]);
  expect(external.filter(specifier => !specifier.startsWith("node:"))).toEqual([]);
});

test("task-runtime submodules reach neither scripts nor the durable or agent layers", async () => {
  const directory = join(repository, "src", "core", "task-runtime");
  const entries = (await readdir(directory)).filter(name => name.endsWith(".ts")).map(name => join(directory, name));
  expect(entries.length).toBeGreaterThan(0);
  const { files } = await graph(entries);
  expect(files.filter(file => !file.startsWith("src/core/") && !file.startsWith("src/contracts/"))).toEqual([]);
});

test("offline maintenance reaches the business layers only through its injected scope", async () => {
  const directory = join(repository, "src", "maintenance");
  const entries = (await readdir(directory)).filter(name => name.endsWith(".ts")).map(name => join(directory, name));
  expect(entries.length).toBeGreaterThan(0);
  const { files } = await graph(entries);
  // The member directory layout (agent/paths.ts, reached through the tmp scan) is naming only, no business state.
  expect(files.filter(file => file.startsWith("src/durable/") || (file.startsWith("src/agent/") && file !== "src/agent/paths.ts"))).toEqual([]);
  expect(files).toContain("src/maintenance/scope.ts");
});

test("the specifier scan sees every import form it is relied on for", async () => {
  const sample = join(import.meta.dir, "boundaries.test.ts");
  const names = await specifiers(sample);
  expect(names).toEqual(expect.arrayContaining(["bun:test", "node:fs/promises", "node:path"]));
  expect(await specifiers(join(contracts, "task-receipt.ts"))).toEqual(expect.arrayContaining(["node:crypto", "./maintenance.ts"]));
});
