import { expect, test } from "bun:test";
import { finishWindows, type HandleEvent, WindowsHandles } from "../../src/core/windows-handles.ts";
import { HeldDirectory } from "../../src/core/held-directory.ts";

function fixture(failures: bigint[] = []) {
  const events: HandleEvent[] = [], closed: bigint[] = [];
  let lastError = 6;
  const native = {
    CloseHandle: (value: bigint) => { closed.push(value); lastError = 6; return failures.includes(value) ? 0 : 1; },
    GetLastError: () => lastError,
  } as unknown as WindowsHandles["native"];
  const resources = new WindowsHandles({ native, observe: event => { events.push(event); lastError = 999; } });
  return { resources, events, closed };
}

test("close-only owners need no directory native library and retain terminal failure across repeated close", () => {
  let attempts = 0, error = 6;
  const resources = new WindowsHandles({ closeNative: { CloseHandle: () => { attempts++; error = 6; return 0; }, GetLastError: () => error },
    observe: () => { error = 999; } });
  const owner = resources.own(1n, "synthetic-process", "OpenProcess");
  expect(() => owner.close()).toThrow("Windows error 6");
  expect(() => owner.close()).toThrow("Windows error 6");
  expect(attempts).toBe(1);
});

test("native close failures capture LastError before observation, close other owners, and preserve the business cause", async () => {
  const { resources, events, closed } = fixture([2n, 3n]);
  const owners = [1n, 2n, 3n].map(value => resources.own(value, `entity-${value}`, "test-open"));
  const business = new Error("original metadata failure");
  let failure: AggregateError | undefined;
  try { await resources.closeAll(owners, business); } catch (error) { failure = error as AggregateError; }
  expect(failure?.cause).toBe(business);
  expect(failure?.errors.map(error => [error.win32, error.code])).toEqual([[6, "EBADF"], [6, "EBADF"]]);
  expect(closed).toEqual([3n, 2n, 1n]);
  expect(owners).toEqual([]);
  expect(events.filter(event => event.phase === "close-result").map(event => [event.success, event.win32]))
    .toEqual([[false, 6], [false, 6], [true, undefined]]);
});

test("a numeric handle reused after closing has a new open sequence; each owner closes at most once", () => {
  const { resources, events, closed } = fixture();
  const first = resources.own(20n, "first", "test-open"); first.close(); first.close();
  expect(() => first.value).toThrow("no longer owned");
  const second = resources.own(20n, "second", "test-open"); second.close(); second.close();
  expect(first.openSequence).not.toBe(second.openSequence);
  expect(closed).toEqual([20n, 20n]);
  const opened = events.filter(event => event.phase === "owned");
  for (const event of opened) {
    expect(events.filter(item => item.phase === "close-result" && item.openSequence === event.openSequence && item.success)).toHaveLength(1);
  }
  expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
  expect(events.every(event => event.pid === process.pid && event.monotonicMs >= 0)).toBe(true);
});

test("a failed close is terminal and repeated release returns the same rejection without a second native close", async () => {
  const { resources, closed } = fixture([9n]);
  const owners = [resources.own(9n, "held", "test-open")];
  const held = new HeldDirectory({ dev: 1n, ino: 2n }, {} as never, () => resources.closeAll(owners));
  const first = held.release();
  expect(held.release()).toBe(first);
  await expect(first).rejects.toBeInstanceOf(AggregateError);
  await expect(held.release()).rejects.toBeInstanceOf(AggregateError);
  await expect(held.use(async () => {})).rejects.toThrow("no longer held");
  expect(closed).toEqual([9n]);
});

test("release waits for active use, forbids new use, and closes once after the barrier", async () => {
  const { resources, closed } = fixture();
  const owners = [resources.own(9n, "held", "test-open")];
  const held = new HeldDirectory({ dev: 1n, ino: 2n }, {} as never, () => resources.closeAll(owners));
  const gate = Promise.withResolvers<void>();
  const running = held.use(() => gate.promise);
  const release = held.release();
  await expect(held.use(async () => {})).rejects.toThrow("no longer held");
  expect(closed).toEqual([]);
  gate.resolve(); await running; await release; await held.release();
  expect(closed).toEqual([9n]);
});

test("cleanup runs all actions and keeps a business error when both Bun and native cleanup fail", async () => {
  const business = new Error("write failed"), actions: number[] = [];
  const bunClose = new Error("Bun close failed"), nativeClose = new Error("native close failed");
  try {
    await finishWindows([
      () => { actions.push(1); throw bunClose; }, () => { actions.push(2); throw nativeClose; }, () => { actions.push(3); },
    ], business);
    throw new Error("expected cleanup failure");
  } catch (error) {
    expect((error as AggregateError).cause).toBe(business);
    expect((error as AggregateError).errors).toEqual([bunClose, nativeClose]);
  }
  expect(actions).toEqual([1, 2, 3]);
});
