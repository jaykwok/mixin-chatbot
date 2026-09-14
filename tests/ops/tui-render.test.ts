// 运维界面的渲染层。
//
// 这一层只有一条真正的不变量：每个组件吐出的每一行，显示宽度必须精确等于给它的宽度。
// 差一列不会报错，只会让右边所有东西错位——而中文占两列、组合符号占零列、颜色转义占零列，
// 三种情况都能让 String.length 算错。所以这里用真实会出现的中文、全角标点和上色文本去压。

import { describe, expect, test } from "bun:test";
import { pad, truncate, width } from "../../scripts/ops/tui/render/width.ts";
import { createTheme, STATUS } from "../../scripts/ops/tui/render/theme.ts";
import { bar, box, columnChart, columns, fields, mark, meter, rule, sparkline, status, table, tile, wrap } from "../../scripts/ops/tui/render/widgets.ts";
import * as fmt from "../../scripts/ops/tui/render/format.ts";
import { listenKeys, type Key } from "../../scripts/ops/tui/render/screen.ts";
import { PassThrough } from "node:stream";
import { footer, navbar, subnav } from "../../scripts/ops/tui/frame.ts";

const CSI = String.fromCharCode(27) + "[";
/** 界面里真实会遇到的几类文本：中文、全角标点、摘要目录名、带色文本、emoji。 */
const SAMPLES = [
  "技术支持群",
  "已跟踪文件有未提交改动，升级会被拒绝",
  "sha256-9f2c4b1e",
  "138****5678",
  "2081562792700661761",
  `${CSI}38;2;57;135;229m上过色的文本${CSI}0m`,
  "",
  "a",
  "✓ ! ✗ ▲ ●",
];

describe("显示宽度", () => {
  test("中文与全角按两列计，ASCII 按一列", () => {
    expect(width("abc")).toBe(3);
    expect(width("技术支持群")).toBe(10);
    expect(width("群 128 次")).toBe(9);
    expect(width("（统计区间）")).toBe(12);
  });

  test("颜色转义不占列", () => {
    const theme = createTheme("truecolor");
    expect(width(theme.c("accent", "技术支持群"))).toBe(10);
    expect(width(status(theme, "danger", "写入失败"))).toBe(10);
  });

  test("状态符号一律占一列，表格不会因状态不同而错位", () => {
    for (const entry of Object.values(STATUS)) {
      expect(width(entry.glyph)).toBe(1);
    }
  });

  test("组合符号与控制字符占零列", () => {
    expect(width("e\u0301")).toBe(1);
    expect(width("\u200b")).toBe(0);
    expect(width("\u0007")).toBe(0);
  });

  test("ANSI 截断保留实际文字，且不会切碎 emoji 或泄漏颜色", () => {
    const colored = `${CSI}31m中文 hello${CSI}0m`;
    expect(Bun.stripANSI(truncate(colored, 7))).toBe("中文 h…");
    expect(truncate(colored, 7).endsWith(`${CSI}0m`)).toBe(true);
    expect(truncate("👩‍💻工作", 3)).toBe("👩‍💻…");
    expect(truncate("e\u0301cole", 3)).toBe("e\u0301c…");
    expect(Bun.stripANSI(truncate(`${CSI}2J正常`, 8))).toBe("正常");
    expect(wrap(`${CSI}31m中文测试${CSI}0m`, 4).map(Bun.stripANSI)).toEqual(["中文", "测试"]);
    for (const line of wrap(colored, 5)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(5);
      expect(line.endsWith(`${CSI}0m`)).toBe(true);
    }
  });

  test("无需截断时也清理控制序列、展开 Tab 并闭合颜色，重复填充不累积 reset", () => {
    const text = `${CSI}2J${CSI}31m群\tA\u0007\u001b]0;改标题\u0007`;
    expect(truncate(text, 20)).toBe(`${CSI}31m群    A${CSI}0m`);
    expect(truncate("\u001b]8;;https://example.com\u001b\\链接\u001b]8;;\u001b\\", 20)).toBe("链接");
    expect(truncate("👩‍💻e\u0301🇨🇳", 20)).toBe("👩‍💻e\u0301🇨🇳");
    let colored = `${CSI}31m中文${CSI}0m`;
    for (let i = 0; i < 10; i++) colored = truncate(colored, 10);
    expect(colored).toBe(`${CSI}31m中文${CSI}0m`);
  });

  test("截断不会切在宽字符中间", () => {
    for (const text of SAMPLES) {
      for (const size of [1, 2, 3, 7, 12, 40]) {
        const out = truncate(text, size);
        expect(width(out)).toBeLessThanOrEqual(size);
      }
    }
  });

  test("填充后的宽度精确等于目标", () => {
    for (const text of SAMPLES) {
      for (const size of [1, 4, 12, 30]) {
        for (const align of ["left", "right", "center"] as const) {
          expect(width(pad(text, size, align))).toBe(size);
        }
      }
    }
  });
});

describe("组件宽度不变量", () => {
  const theme = createTheme("truecolor");
  const plain = createTheme("none");

  for (const [name, current] of [
    ["truecolor", theme],
    ["无色", plain],
  ] as const) {
    test(`${name} 下每个组件的每一行都精确等宽`, () => {
      for (const size of [72, 80, 96, 120]) {
        const rows = [
          { group: "技术支持群", asks: 916, users: 28 },
          { group: "2081562792700661761", asks: 7, users: 2 },
          { group: "ops", asks: 0, users: 1 },
        ];

        const built = box(current, {
          width: size,
          title: "统计",
          note: "2026-08-01 ~ 2026-09-13",
          accent: "accent",
          body: [
            ...fields(current, [["群数据根", "/srv/mixin/groups"], ["占用", "5.8 GB"]], size - 4, 10),
            status(current, "warn", "cloudflared 未记录归属"),
            sparkline(current, [1, 5, 9, 2, 0, 7]),
            meter(current, [{ value: 3, color: "warn" }, { value: 5, color: "accent" }], 10, 12),
            ...table(current, {
              width: size - 4,
              rows,
              selected: 0,
              columns: [
                { header: "群", size: 20, render: (row) => row.group },
                { header: "提问", size: 6, align: "right", render: (row) => String(row.asks) },
                { header: "", size: 2, render: () => mark(current, "ok") },
                { header: "", size: 10, render: (row) => bar(current, row.asks, 916, 10) },
                { header: "人数", flex: 1, align: "right", render: (row) => `${row.users} 人` },
              ],
            }),
          ],
        });
        for (const line of built) expect(width(line)).toBe(size);

        // 无边框的那几个组件走各自的宽度约定，同样要精确等宽。
        for (const line of [
          rule(current, size, "近 14 天提问", "峰值 128 · 今日 5 群"),
          rule(current, size),
          ...tile(current, { width: size, label: "今日提问", value: "126 次", delta: { text: "↑7" }, trend: [3, 9, 4, 8] }),
          ...tile(current, { width: size, label: "数据占用", value: "14.8 GB", foot: "tmp 10.0 GB",
            meter: { total: 100, segments: [{ value: 62, color: "accent" }] } }),
          ...columnChart(current, { width: size, height: 4, values: [62, 0, 128, 33, 96], labels: ["09-01", "09-02", "09-03", "09-04", "09-05"] }),
        ]) expect(width(line)).toBe(size);
      }
    });
  }

  test("指标块窄到放不下图形时，仪表让位给说明文字，趋势线不让", () => {
    // 没有说明的彩色进度条等于让颜色单独承载语义；趋势线砍成半截则会谎报趋势。
    const narrow = tile(theme, { width: 16, label: "数据占用", value: "14.8 GB", foot: "tmp 10.0 GB",
      meter: { total: 100, segments: [{ value: 62, color: "accent" }] } });
    expect(Bun.stripANSI(narrow[2]!)).toContain("tmp 10.0 GB");
    expect(narrow[2]).not.toContain("█");

    const trend = tile(theme, { width: 16, label: "今日提问", value: "126 次", foot: "峰值 128", trend: [1, 4, 2, 9, 5, 7] });
    expect(Bun.stripANSI(trend[2]!).trim()).not.toContain("峰值");
    expect(Bun.stripANSI(trend[2]!).trim().length).toBeGreaterThan(0);
  });

  test("仪表在无色终端下靠字符密度区分，不是只靠颜色", () => {
    const plainMeter = Bun.stripANSI(meter(plain, [{ value: 3, color: "accent" }], 10, 10));
    expect(plainMeter).toBe("███░░░░░░░");
    // 满和空必须长得不一样，否则 NO_COLOR 下每条仪表读起来都是「满的」。
    expect(Bun.stripANSI(meter(plain, [{ value: 10, color: "accent" }], 10, 10)))
      .not.toBe(Bun.stripANSI(meter(plain, [{ value: 0, color: "accent" }], 10, 10)));
  });

  test("柱状图的零值留白、极小值仍可见，峰值与零刻度分列两端", () => {
    const plot = (line: string): string => Bun.stripANSI(line).split(/[│└]/)[1] ?? "";
    const lines = columnChart(plain, { width: 40, height: 4, values: [0, 50, 100] });
    expect(lines[0]).toContain("100");
    expect(lines.at(-1)).toContain("0");
    // 零值那一列整列留白，有值的列画出来。
    expect(plot(lines[3]!).startsWith(" ")).toBe(true);
    expect(plot(lines[3]!)).toContain("█");

    // 小到不够一格的值也要顶出一格：否则「那天没人用」和「那天用得少」看起来一样。
    const tiny = columnChart(plain, { width: 40, height: 4, values: [1, 1000] });
    expect(plot(tiny[3]!).trimEnd().length).toBeGreaterThan(0);
    expect(plot(tiny[3]!).startsWith(" ")).toBe(false);
  });

  test("并排放置的两块加上间隔正好填满整行", () => {
    const left = box(theme, { width: 38, title: "部署", body: ["a"] });
    const right = box(theme, { width: 37, title: "今日", body: ["b", "c"] });
    for (const line of columns([left, right], [38, 37], 1)) {
      expect(width(line)).toBe(76);
    }
  });

  test("折行后每行都不超宽", () => {
    const text = "所有改动都转交给 ops.sh / ops.ps1 执行，清理类操作把文件移到 backup/rm，可按原路径还原。";
    for (const size of [20, 33, 60]) {
      for (const line of wrap(text, size)) expect(width(line)).toBeLessThanOrEqual(size);
    }
  });

  test("标点不落行首，避头点回退后仍然不超宽也不丢字", () => {
    const text = "未配置 data/config/relay.json 时该特性关闭，这里的命令会直接报「未启用」。清理只删后端对象。";
    for (const size of [12, 20, 24, 33, 60]) {
      const lines = wrap(text, size);
      for (const line of lines) expect(width(line)).toBeLessThanOrEqual(size);
      for (const line of lines.slice(1)) {
        expect("。，、；：？！）」』】".includes(Bun.stripANSI(line).trimStart()[0] ?? "")).toBe(false);
      }
      // 回退不能把字吃掉：拼回来必须和原文逐字相同。
      expect(lines.map(line => Bun.stripANSI(line)).join("")).toBe(text);
    }
  });

  test("72 列能看见五个主分区和全部子页，无色模式也保留当前标记", () => {
    const labels = ["总览", "监控", "统计", "数据", "系统"].map(label => ({ id: label, label }));
    for (const depth of ["truecolor", "none"] as const) {
      const lines = navbar(createTheme(depth), 72, labels, "统计", null);
      const text = Bun.stripANSI(lines[0]!);
      for (const { label } of labels) expect(text).toContain(label);
      if (depth === "none") expect(text).toContain("[统计]");
      for (const line of lines) expect(Bun.stringWidth(line)).toBe(72);
      const children = subnav(createTheme(depth), 72, ["会话", "临时文件", "外链"].map(label => ({ id: label, label })), "临时文件");
      expect(Bun.stripANSI(children)).toContain("[临时文件]");
      expect(Bun.stripANSI(children)).toContain("Tab / Shift+Tab");
      expect(Bun.stringWidth(children)).toBe(72);
    }
  });

  test("窄窗口下操作提示再多也不会挤掉主导航、菜单、刷新和退出提示", () => {
    const common: [string, string][] = [["←→", "分区"], ["Tab", "子页"], ["Space", "操作"], ["r", "刷新"], ["?", "帮助"], ["q", "退出"]];
    for (const depth of ["truecolor", "ansi256", "none"] as const) {
      for (const toast of [null, { status: "ok" as const, text: "操作已完成".repeat(40) }]) {
        const lines = footer(createTheme(depth), 72, toast, Array.from({ length: 30 }, () => ["x", "上下文操作"]), common);
        expect(lines).toHaveLength(2);
        for (const line of lines) expect(Bun.stringWidth(line)).toBe(72);
        for (const [key, label] of common) expect(Bun.stripANSI(lines[1]!)).toContain(key + " " + label);
      }
    }
  });
});

describe("嵌套上色", () => {
  const theme = createTheme("truecolor");

  test("反色遇到内部 reset 会重新打开，选中行不会从中间断掉", () => {
    // 进度条自带颜色，它结束时的 0m 会把外层反色一起关掉；wrapStyle 必须补回来。
    const line = theme.invert(`前 ${theme.c("accent", "███")} 后`);
    const resets = line.split(`${CSI}0m`).length - 1;
    const inverts = line.split(`${CSI}7m`).length - 1;
    expect(inverts).toBe(resets);
    expect(line.endsWith(`${CSI}0m`)).toBe(true);
  });

  test("无色终端下选中行仍然看得出来", () => {
    expect(createTheme("none").invert("技术支持群")).toBe("[技术支持群]");
    const rows = table(createTheme("none"), {
      width: 30, rows: ["甲", "乙"], selected: 0,
      columns: [{header: "成员", flex: 1, render: name => name}, {header: "日期", size: 10, render: () => "2026-09-13"}],
    });
    expect(rows[1]).toContain("▸");
    expect(rows[1]!.endsWith("2026-09-13")).toBe(true);
    expect(rows[1]!.indexOf("2026")).toBe(rows[2]!.indexOf("2026"));
  });
});

describe("格式化", () => {
  test("字节按 1024 进制，与 du -h 对得上", () => {
    expect(fmt.bytes(0)).toBe("0 B");
    expect(fmt.bytes(1023)).toBe("1023 B");
    expect(fmt.bytes(1024)).toBe("1.00 KB");
    expect(fmt.bytes(5 * 1024 ** 3)).toBe("5.00 GB");
  });

  test("计数沿用统计口径的「万」", () => {
    expect(fmt.count(9999)).toBe("9999");
    expect(fmt.count(42_000)).toBe("4.2 万");
  });

  test("距今口径与 history/tmp/relay 的三段一致", () => {
    expect(fmt.since(Date.now() - 5 * 60_000)).toBe("5 分钟前");
    expect(fmt.since(Date.now() - 5 * 3600_000)).toBe("5 小时前");
    expect(fmt.since(Date.now() - 5 * 86_400_000)).toBe("5 天前");
  });

  test("手机号保留前三后四，摘要目录名不当手机号处理", () => {
    expect(fmt.maskUser("13812345678")).toBe("138****5678");
    expect(fmt.maskUser(`sha256-user-${"a".repeat(64)}`)).toBe("sha256-user-aaaaaaa…");
    // 打码后的宽度必须稳定，否则成员表会跟着抖。
    expect(width(fmt.maskUser("13812345678"))).toBe(11);
  });
});

describe("按键解析", () => {
  test("分块方向键、Shift+Tab、大小写、中文和 Ctrl+C", async () => {
    const input = new PassThrough();
    const keys: Key[] = [];
    const detach = listenKeys(input, key => keys.push(key));
    try {
      input.write("\u001b[");
      await new Promise<void>(resolve => setImmediate(resolve));
      input.write("A" + CSI + "B" + CSI + "Z\rA群 \u0003");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(keys.map(key => key.name)).toEqual(["up", "down", "tab", "enter", "A", "群", "space", "c"]);
      expect(keys[2]?.shift).toBe(true);
      expect(keys[4]?.text).toBe("A");
      expect(keys[5]?.text).toBe("群");
      expect(keys.at(-1)?.ctrl).toBe(true);
    } finally { detach(); input.destroy(); }
  });

  test("独立 Esc 会在序列等待结束后作为取消，解除监听后不再回调", async () => {
    const input = new PassThrough();
    const keys: Key[] = [];
    const detach = listenKeys(input, key => keys.push(key));
    try {
      input.write("\u001b");
      await Bun.sleep(550);
      expect(keys.map(key => key.name)).toEqual(["escape"]);
      detach();
      input.write("q");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(keys).toHaveLength(1);
    } finally { detach(); input.destroy(); }
  });
});
