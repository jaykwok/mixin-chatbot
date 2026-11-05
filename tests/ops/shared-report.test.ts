// Shared HTML reporting regressions; the browser console's statistics export renders this report.
import { writeTestData as writeFile } from "../helpers/stats-fixture.ts";
// 统计报表导出。
//
// 这份 HTML 会被发给别人、贴进汇报材料，所以两件事必须钉死：
//   1. 群号和成员标识来自外部输入，必须转义——群号允许带任意 Unicode；
//   2. 成员一律按控制台给出的身份标注，报表自己不另出完整号码。
// 另外它必须是自包含的：没有外链，断网、内网、别人的电脑上打开都一样。

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { collectAll, collectGroup } from "../../scripts/ops/stats-admin.ts";
import { maskUser } from "../../scripts/ops/shared/format.ts";
import { renderReport, type ReportInput } from "../../scripts/ops/shared/report.ts";
import { archiveFixture as rm, testTempDir as tmpdir } from "../helpers/temp.ts";

const MASKED: ReportInput["identity"] = { label: maskUser, note: "手机号已打码。", banner: "不含个人信息" };

async function makeRoot(group: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shared-report-"));
  const dir = join(root, group, "users", "13812345678");
  await mkdir(dir, { recursive: true });
  const at = new Date("2026-08-01T10:00:00Z").toISOString();
  await writeFile(
    join(dir, "stats.records"),
    [
      JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text: "统计一下" }] } }),
      JSON.stringify({
        type: "message",
        timestamp: at,
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }], usage: { input: 10, output: 2, cacheRead: 5 } },
      }),
    ].join("\n") + "\n"
  );
  // 报表读的是统计账本，写完会话文件还要入账一次。
  return root;
}

describe("统计报表", () => {
  test("群号和身份文字里的 HTML 被转义，不会注入进报表", async () => {
    // 群号允许带任意 Unicode，目录名会落成 sha256 摘要，但报表里显示的是原始群号。
    const evil = `<img src=x onerror="alert(1)">`;
    const root = await makeRoot("evil-group");
    try {
      const groups = await collectAll(root);
      groups[0]!.group = evil;
      const html = renderReport({ groups, detail: groups[0]!, window: {}, identity: { label: () => evil, note: evil, banner: evil } });
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    } finally {
      await rm(root);
    }
  });

  test("成员在汇总、排行和群明细中都按给定身份标注", async () => {
    const root = await makeRoot("g1");
    try {
      const groups = await collectAll(root);
      const detail = await collectGroup("g1", root);

      const masked = renderReport({ groups, detail, window: {}, identity: MASKED });
      expect(masked).toContain("138****5678");
      expect(masked).not.toContain("13812345678");
      expect(masked).toContain("手机号已打码。");
      expect(masked).toContain("不含个人信息");

      const full = renderReport({ groups, detail, window: {}, identity: { label: user => `成员 ${user}`, note: "含完整手机号。", banner: "含个人信息" } });
      expect(full).toContain("成员 13812345678");
      expect(full).not.toContain("138****5678");
    } finally {
      await rm(root);
    }
  });

  test("自包含：没有任何外部请求", async () => {
    const root = await makeRoot("g1");
    try {
      const groups = await collectAll(root);
      const html = renderReport({ groups, detail: null, window: {}, identity: MASKED });
      expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
      // 每张图都配一份表格视图，任何数值都不只能靠悬浮提示读到。
      expect(html).toContain("table-view");
      // 深浅两套都要有，深色不是把浅色自动反过来。
      expect(html).toContain("prefers-color-scheme");
    } finally {
      await rm(root);
    }
  });
});
