import { expect, test } from "bun:test";
import { createTheme } from "../../scripts/ops/tui/render/theme.ts";
import { width } from "../../scripts/ops/tui/render/width.ts";
import { frame, PAGES } from "../../scripts/ops/tui/preview.ts";

test("preview pages fill 100×24 and 80×24, highlight their own subpage and render at the demo clock", () => {
  const theme = createTheme("none");
  const clock = Date.now;
  for (const page of Object.keys(PAGES)) {
    for (const [columns, rows] of [[100, 24], [80, 24]] as const) {
      const lines = frame(theme, page, columns, rows);
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect(width(line)).toBe(columns);
    }
  }
  expect(Date.now).toBe(clock);
  expect(frame(theme, "storage", 100, 24)[2]).toContain("[临时文件]");
  expect(frame(theme, "relay", 100, 24)[2]).toContain("[外链]");
  // Ages count from the demo moment, not from today.
  expect(frame(theme, "history", 100, 24).join("\n")).toContain("2 小时前");
});
