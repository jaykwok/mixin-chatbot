// Compaction thresholds from the model window (D2-5, src/durable/compaction.ts). The summarize requests through the
// request door are in door.test.ts.
import { describe, expect, test } from "bun:test";
import { BACKGROUND_MAX, compactionPolicy } from "../../src/durable/compaction.ts";

const PI = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

describe("compaction policy from the model window", () => {
  test("background compaction an eighth of the window below the blocking threshold, at most Durable's 32768", () => {
    expect(compactionPolicy(PI, 128000)).toEqual({ ...PI, backgroundTokens: 16000 });
    expect(compactionPolicy(PI, 1_000_000)).toEqual({ ...PI, backgroundTokens: BACKGROUND_MAX });
    expect(BACKGROUND_MAX).toBe(32768);
  });

  test("off when the background threshold would leave less than two keep-recent budgets, or without a window", () => {
    // 64000 − 16384 − 8000 = 39616 < 40000: blocking compaction only.
    expect(compactionPolicy(PI, 64000).backgroundTokens).toBe(0);
    // 65536 − 16384 − 8192 = 40960 ≥ 40000.
    expect(compactionPolicy(PI, 65536).backgroundTokens).toBe(8192);
    expect(compactionPolicy(PI, 0).backgroundTokens).toBe(0);
    expect(compactionPolicy(PI, 10000).backgroundTokens).toBe(0);
  });

  test("Pi's enabled switch and budgets pass through unchanged", () => {
    const off = { enabled: false, reserveTokens: 1024, keepRecentTokens: 2048 };
    expect(compactionPolicy(off, 32000)).toEqual({ ...off, backgroundTokens: 4000 });
  });
});
