import { expect, test } from "bun:test";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBundle, UI_DIR } from "../../scripts/ops/console/bundle.ts";
import { tempFixture } from "../helpers/temp.ts";

const packageVersion = async (path: string) => JSON.parse(await readFile(path, "utf8")).version as string;

test("页面在内存中构建：脚本、样式、图标带内容哈希，页面没有内联脚本，构建结果稳定", async () => {
  const first = await buildBundle(), second = await buildBundle();
  expect([...first.assets.keys()]).toEqual([...second.assets.keys()]);
  const paths = [...first.assets.keys()];
  expect(paths.filter(path => /^\/assets\/app\.[0-9a-f]{12}\.js$/.test(path))).toHaveLength(1);
  expect(paths.filter(path => /^\/assets\/app\.[0-9a-f]{12}\.css$/.test(path))).toHaveLength(1);
  expect(paths.filter(path => /^\/assets\/icon\.[0-9a-f]{12}\.svg$/.test(path))).toHaveLength(1);
  const html = new TextDecoder().decode(first.index.body);
  for (const path of paths) expect(html).toContain(`"${path}"`);
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(html).not.toMatch(/\sstyle=|<style/);
  expect(html).not.toMatch(/https?:\/\//);
  const script = new TextDecoder().decode([...first.assets.values()].find(asset => asset.path.endsWith(".js"))!.body);
  expect(script).not.toContain("sourceMappingURL");
  // Production JSX runtime, and nothing that would fetch from elsewhere at runtime.
  expect(script).not.toContain("jsxDEV");
  expect(script).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
});

test("内置 Preact 与锁定的 node_modules 版本逐字节一致", async () => {
  const vendor = join(UI_DIR, "vendor", "preact"), modules = join(import.meta.dir, "../../node_modules/preact");
  const locked = JSON.parse(await readFile(join(import.meta.dir, "../../package.json"), "utf8")).dependencies.preact;
  expect(await packageVersion(join(modules, "package.json"))).toBe(locked);
  expect(await readFile(join(vendor, "README.md"), "utf8")).toContain(`当前 ${locked}`);
  const copies: Record<string, string> = {
    "preact.mjs": "dist/preact.mjs", "hooks.mjs": "hooks/dist/hooks.mjs", "jsx-runtime.mjs": "jsx-runtime/dist/jsxRuntime.mjs", "LICENSE": "LICENSE",
  };
  expect((await readdir(vendor)).sort()).toEqual([...Object.keys(copies), "README.md"].sort());
  for (const [file, source] of Object.entries(copies)) {
    expect(Buffer.compare(await readFile(join(vendor, file)), await readFile(join(modules, source))), file).toBe(0);
  }
});

test("页面代码只能引用 ui/console/src 内的文件和内置 Preact", async () => {
  const fixture = await tempFixture("console-bundle-");
  try {
    await cp(join(UI_DIR, "vendor"), join(fixture.root, "vendor"), { recursive: true });
    await cp(join(UI_DIR, "icon.svg"), join(fixture.root, "icon.svg"));
    await mkdir(join(fixture.root, "src"));
    const attempt = async (source: string) => {
      await writeFile(join(fixture.root, "src", "main.tsx"), source);
      return buildBundle(fixture.root);
    };
    await expect(attempt(`import { readFileSync } from "node:fs"; console.log(readFileSync);`)).rejects.toThrow("不能引用 node:fs");
    await expect(attempt(`import "bun:sqlite";`)).rejects.toThrow("不能引用 bun:sqlite");
    await expect(attempt(`import { Hono } from "hono"; console.log(Hono);`)).rejects.toThrow("不能引用 hono");
    await expect(attempt(`import { x } from "../outside.ts"; console.log(x);`)).rejects.toThrow("只能引用 ui/console/src 内的文件");
    await writeFile(join(fixture.root, "src", "styles.css"), "body { color: red; }");
    const ok = await attempt(`import { render } from "preact"; import { useState } from "preact/hooks"; import "./styles.css";
      function App() { const [n] = useState(1); return <p>{n}</p>; } render(<App />, document.body);`);
    expect([...ok.assets.keys()]).toHaveLength(3);
  } finally { await fixture.cleanup(); }
});
