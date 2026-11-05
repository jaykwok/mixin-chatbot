// Regenerates the console screenshots in docs/assets from demo data only (see console-screenshots-demo.ts). Modules read
// data/ and write logs/ relative to the working directory, so the demo runs as a child process inside a scratch directory
// under tmp/: the project's data/ is never read or written, and the scratch directory is removed once the child and every
// handle it held are gone. Run from anywhere:
//   bun tests/helpers/console-screenshots.ts [--out <dir>] [--browser <path to Chrome or Edge>]
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const project = resolve(import.meta.dir, "../..");
const { values } = parseArgs({ options: { out: { type: "string" }, browser: { type: "string" } } });
const outDir = resolve(values.out ?? join(project, "docs", "assets"));
const candidates = values.browser ? [values.browser] : [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", Bun.which("google-chrome"), Bun.which("chromium"), Bun.which("microsoft-edge")];
const browser = candidates.find(path => path && Bun.file(path).size > 0);
if (!browser) throw new Error("找不到 Chrome 或 Edge；用 --browser 指定浏览器路径");

await mkdir(join(project, "tmp"), { recursive: true });
const work = await mkdtemp(join(project, "tmp", "console-shots-"));
try {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "console-screenshots-demo.ts"), "--out", outDir, "--browser", browser],
    { cwd: work, stdio: ["ignore", "inherit", "inherit"] });
  process.exitCode = await child.exited;
  if (process.exitCode === 0) console.log(`截图已写入 ${outDir}`);
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
    .catch(error => { console.error(`临时目录未能删除，请手动删除 ${work}：${String(error)}`); process.exitCode = 1; });
}
