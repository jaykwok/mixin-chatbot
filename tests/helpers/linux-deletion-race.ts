import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
const request = JSON.parse(process.argv[2]!) as { path: string; moved: string; replacement: "empty" | "nonempty" | "link"; outside: string };
if (process.platform !== "linux") throw new Error("Linux fixture required");
console.log("READY");
process.stdin.once("data", async () => {
  await rename(request.path, request.moved);
  if (request.replacement === "link") await symlink(request.outside, request.path);
  else {
    await mkdir(request.path);
    if (request.replacement === "nonempty") await writeFile(request.path + "/foreign", "keep");
  }
  console.log("SWAPPED");
  process.exit(0);
});
