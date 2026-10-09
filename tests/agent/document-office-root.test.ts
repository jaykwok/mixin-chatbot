// CI runs the Office acceptance script (tests/helpers/document-office-integration.ts) from the image's read-only project
// root. Checking the test venv prepares data/runtime/tmp below the cwd, so the script must check from its own run directory.
import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCUMENT_TOOLCHAIN_MARKER, documentMarker } from "../../scripts/runtime/document-manifest.ts";
import { venvPythonPath } from "../../src/agent/python-toolchain.ts";
import { DOCUMENT_TOOLCHAIN_PACKAGES } from "../../src/core/config.ts";
import { tempFixture } from "../helpers/temp.ts";

test("the Office acceptance script checks its venv from its run directory, not a read-only project root", async () => {
  const fixture = await tempFixture("office-root-");
  try {
    // A file named data/runtime stands in for the read-only image: nothing can be created below it, while reading
    // data/config/runtime.json on import still finds nothing, as in the image (below a file named data, Linux fails that
    // read with ENOTDIR). The image has logs/, which the logger creates on import, before any script code runs.
    const start = join(fixture.root, "project"), run = join(fixture.root, "run"), venv = join(fixture.root, "venv");
    await mkdir(join(start, "logs"), { recursive: true });
    await mkdir(join(start, "data"));
    await writeFile(join(start, "data", "runtime"), "");
    // The venv passes the marker check, so the check goes on to prepare its temporary directory before it fails.
    const project = fileURLToPath(new URL("../../", import.meta.url));
    await mkdir(dirname(venvPythonPath(venv)), { recursive: true });
    await writeFile(venvPythonPath(venv), "");
    await writeFile(join(venv, DOCUMENT_TOOLCHAIN_MARKER), documentMarker(DOCUMENT_TOOLCHAIN_PACKAGES,
      await readFile(join(project, "uv.lock"), "utf8"), (await readFile(join(project, ".python-version"), "utf8")).trim()));
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/document-office-integration.ts", import.meta.url)), venv, "--root", run], {
      cwd: start, env: { ...process.env, BOT_DEPLOY_BACKUP_ID: undefined }, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).not.toBe(0);
    expect(out + err).toContain("test venv must match uv.lock");
    expect((await stat(join(run, "data/runtime/tmp/document-toolchain"))).isDirectory()).toBe(true);
    expect((await readdir(start)).sort()).toEqual(["data", "logs"]);
    expect(await readdir(join(start, "data"))).toEqual(["runtime"]);
  } finally { await fixture.cleanup(); }
}, 60000);
