import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const contracts = join(repository, "src", "contracts");

/** The TypeScript files below `directory`, vendored code left out. */
async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(join(repository, directory), { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.parentPath.includes("vendor"))
    .map(entry => join(entry.parentPath, entry.name));
}

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

test("contracts load with Node built-ins only: no service, SQLite, FFI or ops code", async () => {
  const entries = (await readdir(contracts)).filter(name => name.endsWith(".ts")).map(name => join(contracts, name));
  expect(entries.length).toBeGreaterThan(0);
  const { files, external } = await graph(entries);
  expect(files.filter(file => !file.startsWith("src/contracts/"))).toEqual([]);
  expect(external.filter(specifier => !specifier.startsWith("node:"))).toEqual([]);
});

test("the host plan reader reaches only the contracts", async () => {
  const { files, external } = await graph([join(repository, "ops", "lib", "tmp-plan.ts")]);
  expect(files.filter(file => file !== "ops/lib/tmp-plan.ts" && !file.startsWith("src/contracts/"))).toEqual([]);
  expect(external.filter(specifier => !specifier.startsWith("node:"))).toEqual([]);
});

test("the host ops core runs without node_modules: what it loads, dynamic imports included, is built-ins and Bun only", async () => {
  const { files, external } = await graph([join(repository, "ops", "core", "cli.ts")], true);
  expect(files).toEqual(expect.arrayContaining(["ops/core/deployment-host.ts", "ops/core/docker-lifecycle.ts",
    "ops/core/windows-lifecycle.ts", "ops/core/deploy-stage.ts", "ops/config/configuration-stage.ts"]));
  expect(external.filter(specifier => !specifier.startsWith("node:") && !specifier.startsWith("bun:") && specifier !== "bun")).toEqual([]);
});

test("task-runtime submodules reach neither ops code nor the durable or agent layers", async () => {
  const directory = join(repository, "src", "core", "task-runtime");
  const entries = (await readdir(directory)).filter(name => name.endsWith(".ts")).map(name => join(directory, name));
  expect(entries.length).toBeGreaterThan(0);
  const { files } = await graph(entries);
  expect(files.filter(file => !file.startsWith("src/core/") && !file.startsWith("src/contracts/") && !file.startsWith("src/lib/"))).toEqual([]);
});

test("offline maintenance reaches the business layers only through its injected scope", async () => {
  const directory = join(repository, "src", "maintenance");
  const entries = (await readdir(directory)).filter(name => name.endsWith(".ts")).map(name => join(directory, name));
  expect(entries.length).toBeGreaterThan(0);
  const { files } = await graph(entries);
  expect(files.filter(file => file.startsWith("src/durable/") || file.startsWith("src/agent/"))).toEqual([]);
  expect(files).toContain("src/maintenance/scope.ts");
});

// The layers depend one way: console → ops → src. Type imports count too: a type is still a dependency.
test("the service imports nothing outside src", async () => {
  const { files } = await graph(await sources("src"));
  expect(files.filter(file => !file.startsWith("src/") && file !== "package.json")).toEqual([]);
});

test("the ops layer never imports the console", async () => {
  const { files } = await graph(await sources("ops"));
  expect(files.filter(file => file.startsWith("console/") || file.startsWith("scripts/") || file.startsWith("tests/"))).toEqual([]);
});

test("the browser code imports only itself", async () => {
  const { files } = await graph(await sources("console/ui/src"));
  expect(files.filter(file => !file.startsWith("console/ui/"))).toEqual([]);
});

test("what the image runs loads only what the Dockerfile copies into it", async () => {
  const entries = (await Promise.all(["src", "ops/lib", "ops/config", "ops/tools"].map(sources))).flat();
  const { files } = await graph(entries, true);
  expect(files.filter(file => !/^(src|ops\/(lib|config|tools))\//.test(file) && file !== "package.json")).toEqual([]);
  const dockerfile = await readFile(join(repository, "Dockerfile"), "utf8");
  for (const tree of ["src", "ops/lib", "ops/config", "ops/tools"]) expect(dockerfile).toContain(`COPY --chown=appuser:appgroup ${tree} ./${tree}\n`);
});

test("the specifier scan sees every import form it is relied on for", async () => {
  const sample = join(import.meta.dir, "boundaries.test.ts");
  const names = await specifiers(sample);
  expect(names).toEqual(expect.arrayContaining(["bun:test", "node:fs/promises", "node:path"]));
  expect(await specifiers(join(contracts, "task-receipt.ts"))).toEqual(expect.arrayContaining(["node:crypto", "./maintenance.ts"]));
  const directory = await mkdtemp(join(tmpdir(), "boundaries-")), sample2 = join(directory, "sample.ts");
  try {
    await writeFile(sample2, 'import type { A } from "./types.ts";\nexport type { B } from "./more.ts";\nimport { c } from "./value.ts";\n');
    expect(await specifiers(sample2)).toEqual(["./types.ts", "./more.ts", "./value.ts"]);
    expect(await specifiers(sample2, true)).toEqual(["./value.ts"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
