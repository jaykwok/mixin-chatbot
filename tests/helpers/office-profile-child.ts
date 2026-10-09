import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOfficeProfile } from "../../src/agent/office-profiles.ts";
import { runProcess } from "../../src/core/process.ts";
const [temp, mode, path] = process.argv.slice(2);
if (mode === "descendant") {
  await writeFile(join(temp!, "descendant.json"), JSON.stringify({ pid: process.pid, path }));
  setInterval(() => {}, 1000);
} else {
  const profile = await createOfficeProfile(temp!);
  await writeFile(join(temp!, "ready.json"), JSON.stringify({ pid: process.pid, path: profile.path }));
  await runProcess({ command: process.execPath, args: [import.meta.path, temp!, "descendant", profile.path], cwd: temp!, timeoutMs: 120_000 });
  await profile.close();
}
