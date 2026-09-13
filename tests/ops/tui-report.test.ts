// 统计报表导出。
//
// 这份 HTML 会被发给别人、贴进汇报材料，所以两件事必须钉死：
//   1. 群号和成员标识来自外部输入，必须转义——群号允许带任意 Unicode；
//   2. 手机号默认打码，不能因为导出就把一份通讯录一起发出去。
// 另外它必须是自包含的：没有外链，断网、内网、别人的电脑上打开都一样。

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectAll, collectGroup } from "../../scripts/ops/stats-admin.ts";
import { writeReport } from "../../scripts/ops/tui/report.ts";
import { archiveFixture as rm, testTempDir as tmpdir } from "../helpers/temp.ts";

const DEPLOYMENT = {
  platform: "linux" as const,
  runtime: "docker" as const,
  port: 1011,
  mode: "cloudflare" as const,
  domain: "bot.example.com",
  groupDataRoot: "/srv/groups",
  groupDataRootIsCustom: true,
};

async function makeRoot(group: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tui-report-"));
  const dir = join(root, group, "users", "13812345678");
  await mkdir(dir, { recursive: true });
  const at = new Date("2026-08-01T10:00:00Z").toISOString();
  await writeFile(
    join(dir, "session.jsonl"),
    [
      JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text: "统计一下" }] } }),
      JSON.stringify({
        type: "message",
        timestamp: at,
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }], usage: { input: 10, output: 2, cacheRead: 5 } },
      }),
    ].join("\n") + "\n"
  );
  return root;
}

describe("统计报表", () => {
  test("群号里的 HTML 被转义，不会注入进报表", async () => {
    // 群号允许带任意 Unicode，目录名会落成 sha256 摘要，但报表里显示的是原始群号。
    const evil = `<img src=x onerror="alert(1)">`;
    const root = await makeRoot("evil-group");
    try {
      const groups = await collectAll(root);
      groups[0]!.group = evil;
      const path = await writeReport({ groups, detail: null, window: {}, deployment: DEPLOYMENT, unmasked: false, dir: root });
      const html = await Bun.file(path).text();
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    } finally {
      await rm(root);
    }
  });

  test("默认打码；显式要求时才输出完整号码", async () => {
    const root = await makeRoot("g1");
    try {
      const groups = await collectAll(root);
      const detail = await collectGroup("g1", root);

      const masked = await writeReport({ groups, detail, window: {}, deployment: DEPLOYMENT, unmasked: false, dir: root });
      const maskedHtml = await Bun.file(masked).text();
      expect(maskedHtml).toContain("138****5678");
      expect(maskedHtml).not.toContain("13812345678");

      const full = await writeReport({ groups, detail, window: {}, deployment: DEPLOYMENT, unmasked: true, dir: root });
      expect(await Bun.file(full).text()).toContain("13812345678");
      expect(full).not.toBe(masked);
      expect(await Bun.file(masked).text()).toBe(maskedHtml);
    } finally {
      await rm(root);
    }
  });

  test("自包含：没有任何外部请求", async () => {
    const root = await makeRoot("g1");
    try {
      const groups = await collectAll(root);
      const path = await writeReport({ groups, detail: null, window: {}, deployment: DEPLOYMENT, unmasked: false, dir: root });
      const html = await Bun.file(path).text();
      expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
      // 每张图都配一份表格视图，任何数值都不只能靠悬浮提示读到。
      expect(html).toContain("table-view");
      // 深浅两套都要有，深色不是把浅色自动反过来。
      expect(html).toContain("prefers-color-scheme");
    } finally {
      await rm(root);
    }
  });

  test("并发导出也使用不同文件，不会用显号报表覆盖打码报表", async () => {
    const root = await makeRoot("g1");
    try {
      const groups = await collectAll(root);
      const paths = await Promise.all(Array.from({ length: 8 }, (_, index) => writeReport({
        groups, detail: groups[0]!, window: {}, deployment: DEPLOYMENT, unmasked: index % 2 === 1, dir: root,
      })));
      expect(new Set(paths).size).toBe(paths.length);
      for (let index = 0; index < paths.length; index++) {
        const html = await Bun.file(paths[index]!).text();
        expect(html.includes("13812345678")).toBe(index % 2 === 1);
      }
    } finally { await rm(root); }
  });
});
