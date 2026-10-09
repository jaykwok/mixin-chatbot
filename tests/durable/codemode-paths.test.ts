// D23-R2-1, D23-R3-2, D23-R3-3: codemode result files go only into the call directory that was checked, whatever
// another writer with the member's rights does to its path meanwhile, and a result names only paths that still name
// what was written, in the member's real tmp. The interleavings run in a child process
// (tests/helpers/codemode-path-race-harness.ts): at the first index open, before each kind of file's temporary file
// (sub-call text, JSON and image; the script's full output and its own image), before the rename, before a failed
// save's cleanup, between making a directory and holding it, between two index lines, and between the output files,
// the call directory (or `codemode/`) is renamed or removed and a junction (a symlink on Linux) to Bob's tmp put in its
// place, moved into Bob's tmp and linked back (on Linux also the full output file alone), or (Windows) made a junction
// in place. The full output is also removed once saved, and its write made to fail (a full disk, permission denied).
//
// Everywhere: Bob's tmp is unchanged, every path the result gives out names what was written there, in Alice's real
// tmp, and no temporary file is left. Once the directory is held, Windows refuses renames and removals (the call goes
// on as normal) and, while it is empty, lets it become a junction in place, which no write then goes through; Linux
// lets the swaps happen, the files go on into the moved directory, and the call fails closed where it would have given
// out a path. A swap before the directory is held is refused by the hold on both.
import { test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type HeldDirectory, holdDirectory } from "../../src/durable/codemode/directory.ts";
import { junctionInPlace } from "../helpers/junction-in-place.ts";
import { tempFixture } from "../helpers/temp.ts";
import { type HandleEvent, WindowsHandles } from "../../src/core/windows-handles.ts";

type Observed = {
  name: string;
  attacks: string[];
  isError: boolean;
  last: string;
  texts: string[];
  aliceTmp: string;
  index: boolean;
  fullOutputPath: boolean;
  bobChanges: string[];
  pathProblems: string[];
  pathsChecked: number;
  leftovers: string[];
  movedEntries?: string[];
};

const NOT_STARTED = "Tool probe_long was not started: the call could not be recorded (";
const GONE = "no longer names what this call wrote there (moved or replaced): results are only written inside the caller's tmp";
const LINKED = "is a link or not a directory: results are only written inside the caller's tmp";
const MADE_LINK = "its directory was made a link (NTSTATUS 0xc0000280): results are only written inside the caller's tmp";
const NO_FULL_OUTPUT = "[Could not save the full output: ";

/** What a scenario shows on one system: the other writer's outcomes, the result, what is in the moved directory. */
type Outcome = { attacks: string[]; result: (o: Observed) => void; moved?: string[] };
const subCall = (o: Observed) => { expect(o.last).toBe("400"); expect(o.index).toBe(true); };
const notStarted = (why: string) => (o: Observed) => { expect(o.last).toStartWith(NOT_STARTED); expect(o.last).toContain(why); expect(o.index).toBe(false); };
const fullOutput = (o: Observed) => { expect(o.texts[0]).toContain("[Full output: "); expect(o.fullOutputPath).toBe(true); };
const noFullOutput = (why: string) => (o: Observed) => {
  expect(o.texts[0]).toContain(`${NO_FULL_OUTPUT}`);
  expect(o.texts[0]).toContain(why);
  expect(o.texts[0]).not.toContain("[Full output: ");
  expect(o.fullOutputPath).toBe(false);
};
const notRecorded = (o: Observed) => {
  expect(o.last).toStartWith("The result of probe_attack could not be recorded: ");
  expect(o.last).toContain(`index.txt ${GONE}`);
  expect(o.index).toBe(false);
};
/**
 * The full output's write failed with `code` (injected): the result says so with the entry's path below Alice's tmp
 * (Windows: the open by path after the create; Linux: the create through /proc/self/fd, which is never shown).
 */
const failedWrite = (code: string, platform: "win32" | "linux"): Outcome => ({ attacks: ["failed"], result: (o) => {
  noFullOutput(code)(o);
  expect(o.texts[0]).toContain(`${NO_FULL_OUTPUT}could not ${platform === "win32" ? "open" : "create"} ${o.aliceTmp}`);
  expect(o.texts[0]).not.toContain("/proc/self/fd");
} });
const BUSY = ["refused:EBUSY"];
/** The held directory holds a file of the call: NTFS refuses to make it a junction (ERROR_DIR_NOT_EMPTY). */
const NOT_EMPTY = ["refused:145"];

const expected: Record<string, Partial<Record<"win32" | "linux", Outcome>>> = {
  "control: every kind of file": {
    // The index, the full output, the image and the three sub-call files (text, JSON, image) named in the index.
    win32: { attacks: [], result: (o) => expect([o.isError, o.index, o.fullOutputPath, o.pathsChecked]).toEqual([false, true, true, 6]) },
    linux: { attacks: [], result: (o) => expect([o.isError, o.index, o.fullOutputPath, o.pathsChecked]).toEqual([false, true, true, 6]) },
  },
  "index first open: call directory renamed": {
    win32: { attacks: BUSY, result: subCall },
    linux: { attacks: ["done"], result: notStarted(`index.txt ${GONE}`), moved: ["index.txt"] },
  },
  "index first open: call directory removed": {
    // Windows: the index is already created and held, so the removal stops at it.
    win32: { attacks: BUSY, result: subCall },
    // The held directory was removed: nothing can be created in it.
    linux: { attacks: ["done"], result: notStarted("index.txt: ENOENT") },
  },
  "index first open: codemode/ renamed": {
    win32: { attacks: BUSY, result: subCall },
    linux: { attacks: ["done"], result: notStarted(`index.txt ${GONE}`), moved: ["index.txt"] },
  },
  "call directory swapped after mkdir, before it is held": {
    linux: { attacks: ["done"], result: notStarted(LINKED) },
  },
  "codemode/ swapped after mkdir, before it is held": {
    linux: { attacks: ["done"], result: notStarted(LINKED) },
  },
  "codemode/ made a junction in place before it is held": {
    win32: { attacks: ["done"], result: notStarted(`codemode ${LINKED}`) },
  },
  "index first create: empty call directory made a junction in place": {
    win32: { attacks: ["done"], result: notStarted(`index.txt: ${MADE_LINK}`) },
  },
  "output-only full text: empty call directory made a junction in place": {
    win32: { attacks: ["done"], result: noFullOutput(MADE_LINK) },
  },
  "standalone image: empty call directory made a junction in place": {
    win32: { attacks: ["done"], result: (o) => {
      expect(o.texts[0]).toStartWith("[Image (image/gif, 42B) could not be saved: could not create ");
      expect(o.texts[0]).toContain(MADE_LINK);
      expect(o.last).toBe("done");
    } },
  },
  "sub-call text: call directory holding the index made a junction in place": {
    win32: { attacks: NOT_EMPTY, result: subCall },
  },
  "index opened for writing: call directory made a junction in place": {
    win32: { attacks: NOT_EMPTY, result: subCall },
  },
  "sub-call text before its temporary file": {
    win32: { attacks: BUSY, result: (o) => expect(o.last).toBe("400") },
    linux: { attacks: ["done"], moved: ["1.txt", "index.txt"], result: (o) => {
      expect(o.last).toStartWith("The result of probe_long could not be saved: ");
      expect(o.last).toContain(`1.txt ${GONE}`);
    } },
  },
  "sub-call JSON before its temporary file": {
    win32: { attacks: BUSY, result: (o) => expect(o.last).toBe("412") },
    linux: { attacks: ["done"], moved: ["1.json", "index.txt"], result: (o) => {
      expect(o.last).toStartWith("The result of probe_json could not be saved: ");
      expect(o.last).toContain(`1.json ${GONE}`);
    } },
  },
  "sub-call image before its temporary file": {
    win32: { attacks: BUSY, result: (o) => expect(o.last).toBe("1") },
    linux: { attacks: ["done"], moved: ["1-1.png", "index.txt"], result: (o) => {
      expect(o.last).toStartWith("The result of probe_image could not be saved: ");
      expect(o.last).toContain(`1-1.png ${GONE}`);
    } },
  },
  "output-only full text before its temporary file": {
    win32: { attacks: BUSY, result: fullOutput },
    linux: { attacks: ["done"], result: noFullOutput(`output.txt ${GONE}`), moved: ["output.txt"] },
  },
  "standalone image before its temporary file": {
    win32: { attacks: BUSY, result: (o) => { expect(o.texts[0]).toMatch(/^\[Image saved to .+output-1\.gif \(image\/gif, 42B\)\]$/); expect(o.last).toBe("done"); } },
    linux: { attacks: ["done"], moved: ["output-1.gif"], result: (o) => {
      expect(o.texts[0]).toStartWith("[Image (image/gif, 42B) could not be saved: ");
      expect(o.texts[0]).toContain(`output-1.gif ${GONE}`);
      expect(o.last).toBe("done");
    } },
  },
  "output-only full text before the rename": {
    linux: { attacks: ["done"], result: noFullOutput(`output.txt ${GONE}`), moved: ["output.txt"] },
  },
  // The save fails either way (a directory has the name); the temporary file is removed through the held directory.
  "failure cleanup: swapped before the temporary file is removed": {
    win32: { attacks: ["prepared", ...BUSY], result: noFullOutput("could not rename ") },
    linux: { attacks: ["prepared", "done"], result: noFullOutput("could not rename "), moved: ["output.txt"] },
  },
  "later index line: call directory renamed during a sub-call": {
    win32: { attacks: BUSY, result: (o) => { expect(o.last).toBe("1"); expect(o.index).toBe(true); } },
    linux: { attacks: ["done"], result: notRecorded, moved: ["index.txt"] },
  },
  "later index line: call directory removed during a sub-call": {
    // Windows: the held index stops the removal.
    win32: { attacks: BUSY, result: (o) => { expect(o.last).toBe("1"); expect(o.index).toBe(true); } },
    linux: { attacks: ["done"], result: notRecorded },
  },
  // D23-R3-2: once a save found the directory moved, the result names no index.
  "sub-call, then full output: call directory renamed before its temporary file": {
    win32: { attacks: BUSY, result: (o) => { fullOutput(o); expect(o.index).toBe(true); } },
    linux: { attacks: ["done"], moved: ["1.txt", "index.txt", "output.txt"], result: (o) => {
      noFullOutput(`output.txt ${GONE}`)(o);
      expect(o.index).toBe(false);
    } },
  },
  // D23-R3-2: the full output, saved first, is withdrawn once the image's save found the directory gone.
  "full output, then image: call directory renamed before the image": {
    linux: { attacks: ["done"], moved: ["output-1.gif", "output.txt"], result: (o) => {
      noFullOutput(GONE)(o);
      expect(o.texts.join("\n")).toContain("[Image (image/gif, 42B) could not be saved: ");
    } },
  },
  "full output, then image: call directory emptied and made a junction in place before the image": {
    win32: { attacks: ["done"], result: (o) => {
      noFullOutput(GONE)(o);
      expect(o.texts.join("\n")).toContain("[Image (image/gif, 42B) could not be saved: could not create ");
      expect(o.texts.join("\n")).toContain(MADE_LINK);
    } },
  },
  // D23-R3-3: written into the same directory, but its path now resolves outside Alice's tmp: not given out.
  "full output: call directory moved into Bob's tmp and linked back": {
    win32: { attacks: BUSY, result: fullOutput },
    linux: { attacks: ["done"], result: noFullOutput(`output.txt ${GONE}`), moved: ["output.txt"] },
  },
  "during a sub-call: call directory moved into Bob's tmp and linked back": {
    win32: { attacks: BUSY, result: (o) => { fullOutput(o); expect(o.index).toBe(true); } },
    // Nothing more is written into the moved directory: only the index is there.
    linux: { attacks: ["done"], moved: ["index.txt"], result: (o) => { noFullOutput(GONE)(o); expect(o.index).toBe(false); } },
  },
  "full output, then image: the full output moved into Bob's tmp and linked back": {
    linux: { attacks: ["done"], result: (o) => {
      noFullOutput(`output.txt ${GONE}`)(o);
      expect(o.texts.join("\n")).toContain("[Image saved to ");
    } },
  },
  "full output, then image: the full output removed before the image": {
    win32: { attacks: ["done"], result: (o) => { noFullOutput(`output.txt ${GONE}`)(o); expect(o.texts.join("\n")).toContain("[Image saved to "); } },
    linux: { attacks: ["done"], result: (o) => { noFullOutput(`output.txt ${GONE}`)(o); expect(o.texts.join("\n")).toContain("[Image saved to "); } },
  },
  "full output: the disk is full": { win32: failedWrite("ENOSPC", "win32"), linux: failedWrite("ENOSPC", "linux") },
  "full output: permission denied": { win32: failedWrite("EACCES", "win32"), linux: failedWrite("EACCES", "linux") },
  "no /proc: nothing is held": {
    linux: { attacks: ["failed"], result: notStarted("codemode result files need /proc mounted (procfs)") },
  },
};

test("results directory changed at every write of a codemode call: never into Bob's tmp; a result names only what is in place", async () => {
  const platform = process.platform === "win32" ? "win32" : "linux";
  const fixture = await tempFixture("codemode-paths-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/codemode-path-race-harness.ts", import.meta.url)), fixture.root],
    { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 170_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const observed = stdout.split("\n").filter((line) => line.startsWith("SCENARIO ")).map((line) => JSON.parse(line.slice(9)) as Observed);
    for (const o of observed) {
      console.log(`codemode paths, ${o.name}: attacks ${JSON.stringify(o.attacks)}; ${JSON.stringify((o.texts[0] ?? o.last).slice(0, 160))}; moved ${JSON.stringify(o.movedEntries)}`);
    }
    expect(observed.map((o) => o.name).sort()).toEqual(Object.keys(expected).filter((name) => expected[name]![platform] !== undefined).sort());
    for (const o of observed) {
      const label = o.name;
      expect([label, o.bobChanges, o.pathProblems, o.leftovers]).toEqual([label, [], [], []]);
      const outcome = expected[label]![platform]!;
      expect([label, o.attacks]).toEqual([label, outcome.attacks]);
      outcome.result(o);
      // Linux: the files went on into the moved directory.
      if (outcome.moved !== undefined) expect([label, o.movedEntries]).toEqual([label, outcome.moved]);
    }
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 180_000);

/** Write `text` to a new file `name` in the held directory. */
function put(held: HeldDirectory, name: string, text: string): Promise<void> {
  return held.use(async (entries) => {
    const file = await entries.create(name);
    try {
      await file.handle.writeFile(text);
      await file.handle.sync();
    } finally { await file.close(); }
  });
}
const outcome = async (attempt: () => Promise<unknown>) => attempt().then(() => "done", (error: NodeJS.ErrnoException) => error.code);
/** Why holding `names` below `base` fails; a hold that succeeds is released at once and gives "held". */
const holdError = async (base: string, names: string[], windows?: WindowsHandles) =>
  holdDirectory(base, names, true, windows).then(async (held) => { await held.release(); return "held"; }, (error: Error) => error.message);

test("held directory: made below the base, files created through it; Windows keeps it, its parents and its open files in place until released, Linux follows it when moved", async () => {
  const fixture = await tempFixture("held-directory-");
  // Released before the fixture is removed, also after a failed expectation (Windows cannot remove a held directory).
  let held: HeldDirectory | undefined;
  try {
    const base = join(fixture.root, "tmp"), other = join(fixture.root, "bob");
    await mkdir(base);
    await mkdir(other);
    await writeFile(join(other, "a.txt"), "Bob");
    held = await holdDirectory(base, ["codemode", "1-call"]);
    const dir = join(base, "codemode", "1-call");
    if (process.platform !== "win32") expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(held.identity.ino).toBe((await stat(dir, { bigint: true })).ino);
    await put(held, "a.txt", "ours");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("ours");
    // A file renamed into place and one removed after a failure, through the directory.
    await held.use(async (entries) => {
      const kept = await entries.create("b.tmp");
      await kept.handle.writeFile("renamed");
      await kept.rename("b.txt");
      await kept.close();
      const dropped = await entries.create("c.tmp");
      await dropped.close(true);
      await expect(entries.create("a.txt")).rejects.toThrow(`could not create ${join(dir, "a.txt")}: EEXIST`);
    });
    expect((await readdir(dir)).sort()).toEqual(["a.txt", "b.txt"]);
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("renamed");
    if (process.platform === "win32") {
      expect(await outcome(() => rename(dir, `${dir}.moved`))).toBe("EBUSY");
      expect(await outcome(() => rename(join(base, "codemode"), join(base, "codemode.moved")))).toBe("EBUSY");
      expect(await outcome(() => rename(base, `${base}.moved`))).toBe("EBUSY");
      // Not empty, the directory cannot become a junction; a file of the call still open cannot be removed.
      await held.use(async (entries) => {
        const open = await entries.create("d.txt");
        try {
          expect(junctionInPlace(dir, other)).toEqual({ set: false, error: 145 });
          expect(await outcome(() => rm(join(dir, "d.txt")))).toBe("EBUSY");
        } finally { await open.close(); }
      });
      // Bun removes the closed files, not the directory.
      expect(await outcome(() => rm(dir, { recursive: true, force: true }))).toBe("EBUSY");
      expect(await readdir(dir)).toEqual([]);
      // Empty, it can be made a junction in place; nothing is created through it then.
      expect(junctionInPlace(dir, other)).toEqual({ set: true });
      await expect(put(held, "e.txt", "ours")).rejects.toThrow(`could not create ${join(dir, "e.txt")}: its directory was made a link`);
      expect(await readdir(other)).toEqual(["a.txt"]);
      await held.release();
      await rm(dir);
    } else {
      await rename(dir, `${dir}.moved`);
      await symlink(other, dir, "dir");
      await put(held, "e.txt", "ours");
      expect((await readdir(`${dir}.moved`)).sort()).toEqual(["a.txt", "b.txt", "e.txt"]);
      await rm(dir);
      await rename(`${dir}.moved`, dir);
      await held.release();
    }
    expect(await readdir(other)).toEqual(["a.txt"]);
    expect(await readFile(join(other, "a.txt"), "utf8")).toBe("Bob");
    await expect(held.use(async () => "late")).rejects.toThrow("the call's results directory is no longer held");
    // Released: the directories can be moved again.
    await rename(join(base, "codemode"), join(base, "codemode.released"));
  } finally { await held?.release(); await fixture.cleanup(); }
});

test("held directory: release waits for the work running through it; a link, a junction made in place or a file in place of a name is refused", async () => {
  const fixture = await tempFixture("held-directory-refused-");
  const events: HandleEvent[] = [];
  const windows = new WindowsHandles({ observe: event => events.push(event) });
  let held: HeldDirectory | undefined;
  let moved: string | undefined;
  try {
    const base = join(fixture.root, "tmp"), other = join(fixture.root, "bob");
    await mkdir(join(base, "codemode"), { recursive: true });
    await mkdir(other);
    held = await holdDirectory(base, ["codemode", "1-call"], true, windows);
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const running = held.use(async (entries) => {
      await gate;
      const file = await entries.create("late.txt");
      await file.handle.writeFile("written before the release");
      await file.close();
    });
    let released = false;
    const release = held.release().then(() => { released = true; });
    await Bun.sleep(50);
    expect(released).toBe(false);
    open();
    await running;
    await release;
    expect(await readFile(join(base, "codemode", "1-call", "late.txt"), "utf8")).toBe("written before the release");

    await symlink(other, join(base, "codemode", "2-link"), "junction");
    expect(await holdError(base, ["codemode", "2-link"], windows)).toContain(`2-link ${LINKED}`);
    await writeFile(join(base, "codemode", "3-file"), "not a directory");
    expect(await holdError(base, ["codemode", "3-file"], windows)).toContain(`3-file ${LINKED}`);
    if (process.platform === "win32") {
      await mkdir(join(base, "codemode", "4-in-place"));
      expect(junctionInPlace(join(base, "codemode", "4-in-place"), other, windows)).toEqual({ set: true });
      expect(await holdError(base, ["codemode", "4-in-place"], windows)).toContain(`4-in-place ${LINKED}`);
    }
    expect(await readdir(other)).toEqual([]);
    // Every refused hold closed what it had opened: on Windows a handle left open would keep the tmp from moving.
    const renameStarted = performance.now();
    moved = await rename(base, `${base}.moved`).then(() => "done", (error: NodeJS.ErrnoException) => {
      console.error(`held-directory-first-rename ${JSON.stringify({ code: error.code, errno: error.errno, syscall: error.syscall,
        path: error.path, message: error.message, elapsedMs: performance.now() - renameStarted })}`);
      return error.code ?? error.message;
    });
    expect(moved).toBe("done");
  } finally {
    await held?.release();
    if (process.platform === "win32") console.log(`held-directory-lifecycle ${JSON.stringify({ events, moved })}`);
    // A handle left open would hold the fixture too, and archiving it retries for a minute on Windows (fs-extra's move):
    // keep it then, so the assertion above is what the run reports.
    if (moved === undefined || moved === "done") await fixture.cleanup();
  }
});

// D23-R4-1: a native call failing while the directories are held (Windows; the harness wraps the real kernel32/ntdll
// symbols in a child process), or a junction refused by its attributes, leaves no handle open: every handle opened is
// closed once and the member's tmp can move.
test.skipIf(process.platform !== "win32")("held directory: a failed metadata read, final-path check or refused junction closes every handle opened (Windows)", async () => {
  const fixture = await tempFixture("held-directory-native-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/codemode-native-failure-harness.ts", import.meta.url)), fixture.root],
    { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 50_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const cases = stdout.split("\n").filter((line) => line.startsWith("CASE ")).map((line) => JSON.parse(line.slice(5)));
    for (const each of cases) console.log(`native failure, ${JSON.stringify(each)}`);
    expect(cases.map((each) => each.name)).toEqual([
      "metadata of the member's tmp", "metadata of codemode/", "metadata of the call directory", "identity of the held call directory",
      "metadata of a file created in it", "final path of the member's tmp", "a junction in place of codemode/",
    ]);
    const reasons: Record<string, string> = {
      "final path of the member's tmp": "(Windows error 5)",
      "a junction in place of codemode/": `codemode ${LINKED}`,
    };
    for (const each of cases) {
      expect([each.name, each.failure.includes(reasons[each.name] ?? "(Windows error 5)")]).toEqual([each.name, true]);
      expect([each.name, each.failedHandleClosed, each.unclosed, each.badCloses, each.closed, each.entries, each.move])
        .toEqual([each.name, each.name === "a junction in place of codemode/" ? null : true, 0, 0, each.opened, [], "moved"]);
    }
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 60_000);

// The same on Linux, where holding opens the next directory before closing the one above: a close that fails (the
// harness wraps node:fs/promises in a child process) leaves no descriptor of the hold open.
test.skipIf(process.platform !== "linux")("held directory: a failed close on the way down leaves no descriptor open (Linux)", async () => {
  const fixture = await tempFixture("held-directory-close-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/codemode-close-failure-harness.ts", import.meta.url)), fixture.root],
    { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 50_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const cases = stdout.split("\n").filter((line) => line.startsWith("CASE ")).map((line) => JSON.parse(line.slice(5)));
    for (const each of cases) console.log(`close failure, ${JSON.stringify(each)}`);
    expect(cases).toEqual([
      { name: "nothing fails", failure: "none", open: [] },
      { name: "closing the member's tmp fails", failure: "injected close failure", open: [] },
      { name: "closing codemode/ fails", failure: "injected close failure", open: [] },
    ]);
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 60_000);

test("held directory: parallel creates, writes and renames through it", async () => {
  const fixture = await tempFixture("held-directory-parallel-");
  let held: HeldDirectory | undefined;
  try {
    const base = join(fixture.root, "tmp");
    await mkdir(base);
    const current = held = await holdDirectory(base, ["codemode", "1-call"]);
    const names = Array.from({ length: 24 }, (_, i) => `${i}.txt`);
    await Promise.all(names.map((name) => current.use(async (entries) => {
      const file = await entries.create(`${name}.tmp`);
      try {
        await file.handle.writeFile(name.repeat(2000));
        await file.handle.sync();
        await file.rename(name);
      } finally { await file.close(); }
    })));
    const dir = join(base, "codemode", "1-call");
    expect((await readdir(dir)).sort()).toEqual([...names].sort());
    for (const name of names) expect(await readFile(join(dir, name), "utf8")).toBe(name.repeat(2000));
  } finally { await held?.release(); await fixture.cleanup(); }
});

test("held directory: a path longer than Windows' MAX_PATH", async () => {
  const fixture = await tempFixture("held-directory-long-");
  try {
    let base = fixture.root;
    while (base.length < 280) base = join(base, "长目录名-long-directory-name");
    await mkdir(base, { recursive: true });
    const held = await holdDirectory(base, ["codemode", "1-call"]);
    try {
      await put(held, "a.txt", "ours");
      await held.use(async (entries) => {
        const file = await entries.create("b.tmp");
        await file.handle.writeFile("renamed");
        await file.rename("b.txt");
        await file.close();
      });
      expect(await readFile(join(base, "codemode", "1-call", "a.txt"), "utf8")).toBe("ours");
      expect(await readFile(join(base, "codemode", "1-call", "b.txt"), "utf8")).toBe("renamed");
    } finally { await held.release(); }
  } finally { await fixture.cleanup(); }
});
