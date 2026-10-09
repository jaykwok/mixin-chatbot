// D23-R4-1 on Linux: holding goes down one directory at a time, opening the next before closing the one above. A close
// that fails (here: it closes, then rejects) must not leave the directory just opened open. After each case no
// descriptor of this process names a path in the fixture (/proc/self/fd). Run in a child process
// (tests/durable/codemode-paths.test.ts) so the wrapped node:fs/promises cannot affect other tests.
// Prints one `CASE <json>` line each.
//   bun tests/helpers/codemode-close-failure-harness.ts <fixture-root>
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (root === undefined || process.platform !== "linux") throw new Error("usage (Linux): codemode-close-failure-harness.ts <fixture-root>");

const actual = { ...fs };
/** The directory whose handle's close rejects (after closing). */
let failClose: ((path: string) => boolean) | undefined;
mock.module("node:fs/promises", () => ({ ...actual,
  async open(...args: Parameters<typeof fs.open>) {
    const handle = await actual.open(...args);
    if (failClose === undefined || !failClose(String(args[0]))) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === "close") {
          return async () => {
            await target.close();
            throw Object.assign(new Error("injected close failure"), { code: "EIO" });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
}));
const { holdDirectory } = await import("../../src/durable/codemode/directory.ts");

/** Paths in the fixture that descriptors of this process name. */
async function openInFixture(): Promise<string[]> {
  const real = await actual.realpath(root!);
  const fds = await actual.readdir("/proc/self/fd");
  const targets = await Promise.all(fds.map((fd) => actual.readlink(`/proc/self/fd/${fd}`).catch(() => "")));
  return targets.filter((target) => target === real || target.startsWith(`${real}/`));
}

type Case = { name: string; fail?: (base: string) => (path: string) => boolean };
const cases: Case[] = [
  { name: "nothing fails" },
  { name: "closing the member's tmp fails", fail: (base) => (path) => path === base },
  { name: "closing codemode/ fails", fail: () => (path) => path.endsWith("/codemode") },
];
let index = 0;
for (const each of cases) {
  const base = join(root, `case-${++index}`, "alice");
  await actual.mkdir(base, { recursive: true });
  failClose = each.fail?.(base);
  let failure = "none";
  try {
    const held = await holdDirectory(base, ["codemode", "1-call"]);
    await held.release();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  failClose = undefined;
  console.log(`CASE ${JSON.stringify({ name: each.name, failure, open: await openInFixture() })}`);
}
