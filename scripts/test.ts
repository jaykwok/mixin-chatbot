// Give tests an isolated cwd; never load a developer's data/config or write live state.
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const project = fileURLToPath(new URL("../", import.meta.url));
const parent = join(project, "agents/temp");
await mkdir(parent, { recursive: true });
const cwd = await mkdtemp(join(parent, "tests-"));
const fixtures = join(cwd, "fixtures");
await mkdir(fixtures);
const args = process.argv.slice(2);
const targets = args.filter(arg => !arg.startsWith("-") && existsSync(join(project, arg)));
const child = Bun.spawn([process.execPath, "test", ...(targets.length ? [] : [join(project, "tests")]),
  ...args.map(arg => targets.includes(arg) ? join(project, arg) : arg)], { cwd, env: { ...process.env, TEMP: fixtures, TMP: fixtures, TMPDIR: fixtures,
  TEST_TEMP_ROOT: fixtures, TEST_TRASH_DIR: join(project, "agents/rm"), GROUP_DATA_ROOT: "data/groups" },
  stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.exitCode = await child.exited;
