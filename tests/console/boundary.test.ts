// The console host runs on Linux Docker hosts that have no node_modules: its static import graph may reach only
// node:/bun: built-ins. npm packages are allowed only behind dynamic import() on write paths.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

const project = resolve(import.meta.dir, "../..");
const STATIC = /^\s*(import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;

async function staticGraph(entries: string[]): Promise<{ files: Set<string>; external: Map<string, string[]> }> {
  const files = new Set<string>(), external = new Map<string, string[]>();
  const pending = entries.map(entry => join(project, entry));
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(STATIC)) {
      // `import { type A, type B } from` is erased as well.
      if (match[1] === "import" && /^\s*import\s*\{[^}]*\}/.test(match[0]) && /\{\s*(type\s+\w+\s*,?\s*)+\}/.test(match[0])) continue;
      const specifier = match[2] ?? match[3]!;
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
      else if (!specifier.startsWith("node:") && !specifier.startsWith("bun:") && specifier !== "bun") {
        external.set(specifier, [...external.get(specifier) ?? [], relative(project, file).replaceAll("\\", "/")]);
      }
    }
  }
  return { files, external };
}

test("控制台入口、任务执行器和共用核心的静态依赖只有内置模块", async () => {
  const { files, external } = await staticGraph(["console/server/start.ts", "console/server/main.ts", "console/server/executor.ts", "ops/core/cli.ts"]);
  expect(Object.fromEntries(external)).toEqual({});
  const reached = [...files].map(file => relative(project, file).replaceAll("\\", "/"));
  // The host never loads page code at runtime; the page shares only erased types with it.
  expect(reached.filter(file => file.startsWith("ui/"))).toEqual([]);
  expect(reached).toContain("console/server/data.ts");
});

test("页面代码只引用 Preact 和自身文件，不引用 Node/Bun 或宿主机代码", async () => {
  const offending: string[] = [];
  for await (const file of new Glob("**/*.{ts,tsx}").scan(join(project, "console/ui/src"))) {
    const text = await readFile(join(project, "console/ui/src", file), "utf8");
    for (const match of text.matchAll(/\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/gm)) {
      const specifier = match[1] ?? match[2] ?? match[3]!;
      if (/^preact(\/hooks)?$/.test(specifier) || /^\.\/[\w-]+\.(ts|tsx|css)$/.test(specifier)) continue;
      offending.push(`${file}: ${specifier}`);
    }
  }
  expect(offending).toEqual([]);
});
