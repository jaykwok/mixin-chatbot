import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const contracts = join(repository, "src", "contracts");

/**
 * Every module specifier a TypeScript file names: static imports and re-exports, `import type`, and dynamic imports.
 * `runtime` leaves out `import type` and `export type` statements, which Bun erases: what loading the file loads.
 */
async function specifiers(file: string, runtime = false): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return [...text.matchAll(/^\s*(?:import|export)\b([^;]*?)\bfrom\s*"([^"]+)"|^\s*import\s*"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|\brequire\(\s*"([^"]+)"\s*\)/gms)]
    .filter(match => !runtime || match[2] === undefined || !/^\s*type\b/.test(match[1]!))
    .map(match => match[2] ?? match[3] ?? match[4] ?? match[5]!);
}

/** Walk relative imports from the entry files; report each file reached and each package/builtin named on the way. */
async function graph(entries: string[], runtime = false): Promise<{ files: string[]; external: string[] }> {
  const files = new Set<string>(), external = new Set<string>(), pending = [...entries];
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of await specifiers(file, runtime)) {
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

test("the host ops core runs without node_modules: what it loads, dynamic imports included, is built-ins and Bun only", async () => {
  const { files, external } = await graph([join(repository, "scripts", "ops", "core", "cli.ts")], true);
  expect(files).toEqual(expect.arrayContaining(["scripts/ops/core/deployment-host.ts", "scripts/ops/core/docker-lifecycle.ts",
    "scripts/ops/core/windows-lifecycle.ts", "scripts/ops/core/deploy-stage.ts", "scripts/config/configuration-stage.ts"]));
  expect(external.filter(specifier => !specifier.startsWith("node:") && !specifier.startsWith("bun:") && specifier !== "bun")).toEqual([]);
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
  expect(files.filter(file => file.startsWith("src/durable/") || file.startsWith("src/agent/"))).toEqual([]);
  expect(files).toContain("src/maintenance/scope.ts");
});

test("the specifier scan sees every import form it is relied on for", async () => {
  const sample = join(import.meta.dir, "boundaries.test.ts");
  const names = await specifiers(sample);
  expect(names).toEqual(expect.arrayContaining(["bun:test", "node:fs/promises", "node:path"]));
  expect(await specifiers(join(contracts, "task-receipt.ts"))).toEqual(expect.arrayContaining(["node:crypto", "./maintenance.ts"]));
  const state = join(repository, "src", "core", "ops-maintenance-state.ts"), typeOnly = "../../scripts/ops/core/maintenance.ts";
  expect(await specifiers(state)).toContain(typeOnly);
  expect(await specifiers(state, true)).not.toContain(typeOnly); expect(await specifiers(state, true)).toContain("../contracts/ops-writer.ts");
});
