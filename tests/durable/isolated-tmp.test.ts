// PR-1 (docs/dev/prompt-review-20261102.md): under rootless isolation every bash command runs in its own directory below
// the member's tmp and sees it as PI_USER_TMP, while edit/write may only write the request's directory. The old prompt
// told the model to look the path up in bash, which under isolation names a directory write refuses; the prompt now names
// the request's directory in the tail (closeout.ts) and says how isolated commands differ. Only the rootless backend is a
// fixture: it runs the command locally in `.isolated-work/<id>/work`, as RootlessTasks.reserve names it.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { groupScope } from "../../src/core/layout.ts";
import { runProcess } from "../../src/core/process.ts";
import * as taskBackend from "../../src/core/task-backend.ts";
import { isPathInside } from "../../src/contracts/paths.ts";
import { createMemberEnv } from "../../src/durable/member-env.ts";
import { tempFixture } from "../helpers/temp.ts";

let restore: (() => void) | undefined;
beforeEach(() => {
  const backend = {
    // The task control root (receipts), closed to tools; it does not exist here.
    root: join(tmpdir(), `isolated-tmp-control-${randomUUID()}`),
    async create(tempDir: string) {
      const id = randomUUID(), path = join(tempDir, ".isolated-work", id, "work");
      await mkdir(path, { recursive: true });
      return { id, path, run: (options: Parameters<typeof runProcess>[0]) => runProcess(options), seal: async () => {} };
    },
  };
  const spy = spyOn(taskBackend, "configuredRootlessTasks").mockReturnValue(backend as never);
  restore = () => spy.mockRestore();
});
afterEach(() => { restore?.(); restore = undefined; });

test("isolated bash names its own PI_USER_TMP; write refuses it and accepts the request's directory; read and later commands differ", async () => {
  const f = await tempFixture("isolated-tmp-");
  try {
    const workspace = join(f.root, "workspace"), member = join(f.root, "tmp", "1001"), request = join(member, "tasks", "msg-1");
    for (const dir of [workspace, request]) await mkdir(dir, { recursive: true });
    const env = await createMemberEnv({ workspaceDir: workspace, tempDir: member, requestDir: request, phone: "1001", scope: groupScope("g"),
      venvDir: join(f.root, "venv"), materialsIndexPath: join(f.root, "index", "materials.md") });
    const run = async (command: string) => {
      let output = "";
      const result = await env.exec(command, { onOutput: (text: string) => { output += text; } }, context);
      expect(result.ok).toBe(true);
      return output.trim();
    };
    const first = await run(`printf data > "$PI_USER_TMP/out.txt"; printf %s "$PI_USER_TMP"`);
    expect(isPathInside(first, join(member, ".isolated-work"))).toBe(true);
    expect(isPathInside(first, request)).toBe(false);
    // What the old prompt led to: write to the directory bash reported.
    expect((await env.writeFile(join(first, "draft.txt"), "x", context)).ok).toBe(false);
    expect((await env.writeFile(join(request, "draft.txt"), "x", context)).ok).toBe(true);
    // The command's output stays readable at its full path.
    expect(await env.readTextFile(join(first, "out.txt"), context)).toEqual({ ok: true, value: "data" });
    // Each command has a new directory.
    expect(await run(`printf %s "$PI_USER_TMP"`)).not.toBe(first);
  } finally { await f.cleanup(); }
});
