// D23-R4-1: a held directory's native calls failing on Windows, run in a child process (tests/durable/codemode-paths.test.ts)
// with an explicit native dependency. The real CreateFileW, NtCreateFile and CloseHandle
// run; only the chosen call is made to fail: the nth GetFileInformationByHandle (Windows error 5), or
// GetFinalPathNameByHandleW (Windows error 5). One more case fails nothing: a junction in place of codemode/
// is refused by its attributes. After each case every handle opened was closed exactly once (opens and closes balance,
// no close fails, as a second close of the same handle would), and the member's tmp can be renamed: nothing holds it.
// Prints one `CASE <json>` line each.
//   bun tests/helpers/codemode-native-failure-harness.ts <fixture-root>
import { mkdir, readdir, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { type HandleEvent, WindowsHandles } from "../../src/core/windows-handles.ts";

const root = process.argv[2];
if (root === undefined || process.platform !== "win32") throw new Error("usage (Windows): codemode-native-failure-harness.ts <fixture-root>");

const actual = new WindowsHandles({ observe: () => {} }).native;
let infoCalls = 0;
let failInfoAt = 0;
let failFinal = false;
let injected = false;
let failedHandle: bigint | undefined;
const events: HandleEvent[] = [];
const closes: bigint[] = [];
let badCloses = 0;
const resources = new WindowsHandles({ observe: event => events.push(event), native: { ...actual,
  GetFileInformationByHandle(...call: Parameters<typeof actual.GetFileInformationByHandle>) {
    if (++infoCalls === failInfoAt) { failedHandle = BigInt(call[0] as bigint); injected = true; return 0; }
    return actual.GetFileInformationByHandle(...call);
  },
  GetFinalPathNameByHandleW(...call: Parameters<typeof actual.GetFinalPathNameByHandleW>) {
    if (failFinal) { failedHandle = BigInt(call[0] as bigint); injected = true; return 0; }
    return actual.GetFinalPathNameByHandleW(...call);
  },
  GetLastError() {
    if (injected) { injected = false; return 5; }
    return actual.GetLastError();
  },
  CloseHandle(handle: bigint | number) {
    const done = actual.CloseHandle(handle);
    closes.push(BigInt(handle));
    if (!done) badCloses++;
    return done;
  },
} });
const { holdDirectory } = await import("../../src/durable/codemode/directory.ts");

type Case = { name: string; info?: number; final?: boolean; create?: boolean; junction?: boolean };
const cases: Case[] = [
  { name: "metadata of the member's tmp", info: 1 },
  { name: "metadata of codemode/", info: 2 },
  { name: "metadata of the call directory", info: 3 },
  { name: "identity of the held call directory", info: 4 },
  { name: "metadata of a file created in it", info: 5, create: true },
  { name: "final path of the member's tmp", final: true },
  // Nothing fails: the attributes refuse it, and the handle opened on the junction is closed once.
  { name: "a junction in place of codemode/", junction: true },
];
let index = 0;
for (const each of cases) {
  const base = join(root, `case-${++index}`, "alice");
  await mkdir(base, { recursive: true });
  if (each.junction) {
    await mkdir(join(root, `case-${index}`, "bob"));
    await symlink(join(root, `case-${index}`, "bob"), join(base, "codemode"), "junction");
  }
  infoCalls = 0;
  failInfoAt = each.info ?? 0;
  failFinal = each.final ?? false;
  failedHandle = undefined;
  events.length = 0;
  closes.length = 0;
  badCloses = 0;
  let failure = "none";
  try {
    const held = await holdDirectory(base, ["codemode", "1-call"], true, resources);
    try {
      if (each.create) await held.use((entries) => entries.create("x.txt"));
    } finally { await held.release(); }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  failInfoAt = 0;
  failFinal = false;
  const opened = events.filter(event => event.phase === "owned");
  const unclosed = opened.filter(event => !events.some(closed => closed.phase === "close-result" && closed.success && closed.openSequence === event.openSequence)).length;
  const entries = each.create ? await readdir(join(base, "codemode", "1-call")) : [];
  const move = await rename(base, `${base}.moved`).then(() => "moved", (error: NodeJS.ErrnoException) => error.code ?? String(error));
  console.log(`CASE ${JSON.stringify({
    name: each.name, failure, failedHandleClosed: failedHandle === undefined ? null : closes.includes(failedHandle),
    opened: opened.length, closed: closes.length, unclosed, badCloses, entries, move, events,
  })}`);
}
