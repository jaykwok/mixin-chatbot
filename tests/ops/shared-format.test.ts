// Shared formatting contracts used by the console, the report and the command-line tools.
import { describe, expect, test } from "bun:test";
import { describeAge } from "../../scripts/lib/age.ts";
import * as fmt from "../../scripts/ops/shared/format.ts";

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

  test("距今口径分钟、小时、天三段", () => {
    expect(describeAge(Date.now() - 5 * 60_000)).toBe("5 分钟前");
    expect(describeAge(Date.now() - 5 * 3600_000)).toBe("5 小时前");
    expect(describeAge(Date.now() - 5 * 86_400_000)).toBe("5 天前");
  });

  test("手机号保留前三后四，摘要目录名不当手机号处理", () => {
    expect(fmt.maskUser("13812345678")).toBe("138****5678");
    expect(fmt.maskUser(`sha256-user-${"a".repeat(64)}`)).toBe("sha256-user-aaaaaaa…");
  });
});

