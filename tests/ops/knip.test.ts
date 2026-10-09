import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await tempFixture("knip-entry-");
afterAll(() => fixture.cleanup());
const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const config = JSON.parse(await readFile(join(project, "knip.json"), "utf8")) as { entry: string[] };
type Report = { issues: { file: string; files?: { name: string }[]; dependencies?: { name: string }[] }[] };

async function inspect(root: string, production: boolean) {
  const child = Bun.spawn([process.execPath, join(project, "node_modules/knip/bin/knip-bun.js"),
    "--directory", root, "--no-gitignore", "--no-progress", "--reporter", "json", ...(production ? ["--production"] : [])],
  { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (!stdout.trim()) throw new Error(`Knip exited ${code} without a report:\n${stderr}`);
  return { code, stderr, report: JSON.parse(stdout) as Report };
}

for (const production of [false, true]) test(`Knip's declared Bun entry keeps used code and detects unused code; production=${production}`, async () => {
  const root = join(fixture.root, production ? "production" : "normal");
  await mkdir(join(root, "src/server"), { recursive: true });
  await symlink(join(project, "node_modules"), join(root, "node_modules"), "junction");
  const pkg = { name: "synthetic-knip-entry", private: true, type: "module",
    scripts: { start: "bun run src/server/index.ts", deadcode: "knip" },
    dependencies: { hono: manifest.dependencies.hono }, devDependencies: { knip: manifest.devDependencies.knip } };
  await writeFile(join(root, "package.json"), JSON.stringify(pkg));
  await writeFile(join(root, "knip.json"), JSON.stringify({
    entry: config.entry.filter(entry => entry === "src/server/index.ts!"), project: ["src/**/*.ts!"], includeEntryExports: true,
  }));
  await writeFile(join(root, "src/server/index.ts"), 'import { Hono } from "hono";\nimport { greeting } from "../greeting.ts";\nconst app = new Hono();\napp.get("/", c => c.text(greeting));\n');
  await writeFile(join(root, "src/greeting.ts"), 'export const greeting = "synthetic";\n');
  const used = await inspect(root, production);
  expect(used.code, used.stderr).toBe(0);
  expect(used.report).toEqual({ issues: [] });

  await writeFile(join(root, "src/unused.ts"), 'export const unused = true;\n');
  await writeFile(join(root, "package.json"), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, marked: manifest.dependencies.marked } }));
  const unused = await inspect(root, production);
  expect(unused.code, unused.stderr).toBe(1);
  expect(unused.report.issues.filter(item => item.files?.length).map(item => item.file.replaceAll("\\", "/"))).toEqual(["src/unused.ts"]);
  expect(unused.report.issues.flatMap(item => item.dependencies?.map(dep => dep.name) ?? [])).toEqual(["marked"]);
}, 60000);
