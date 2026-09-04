// 提示词里那几句「已经装好」「清单已建好」是模型信以为真的事实陈述。一旦条件分支写反，
// 模型会照着不存在的解释器和不存在的清单干活，而这类错误在群里表现为莫名其妙的失败，
// 不会有任何编译期信号。这里锁住分支与降级措辞。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildChatContext } from "../../src/agent/runtime.ts";
import type { MaterialsIndexSummary } from "../../src/agent/materials-index.ts";

const tempDir = join("data", "groups", "group-a", "users", "+861", "tmp");
const index: MaterialsIndexSummary = {
  path: join("data", "groups", "group-a", "index", "materials.md"),
  totalFiles: 1523,
  totalBytes: 4_200_000_000,
  generatedAt: Date.now(),
  topLevel: [
    { name: "产品资料/", files: 1204, bytes: 3_900_000_000 },
    { name: "案例/", files: 319, bytes: 300_000_000 },
  ],
  truncated: false,
};

describe("group chat system prompt", () => {
  test("states the job before the plumbing", () => {
    const prompt = buildChatContext({ tempDir, index, pythonReady: true });
    expect(prompt.indexOf("## 角色")).toBeLessThan(prompt.indexOf("## 临时目录"));
    expect(prompt).toContain("资料助手");
    expect(prompt).toContain(tempDir);
  });

  test("points at the index when there is one, and at find when there is not", () => {
    const withIndex = buildChatContext({ tempDir, index, pythonReady: true });
    expect(withIndex).toContain("$PI_MATERIALS_INDEX");
    expect(withIndex).toContain("产品资料/");
    expect(withIndex).toContain("grep");

    const withoutIndex = buildChatContext({ tempDir, index: null, pythonReady: true });
    expect(withoutIndex).toContain("没有可用的资料清单");
    expect(withoutIndex).not.toContain("$PI_MATERIALS_INDEX");
  });

  // 缓存：请求是 [system prompt][历史消息…]，前缀缓存按最长公共前缀匹配，system prompt
  // 变一个字符，后面整段历史就要按全价重吃一遍。而这段上下文是建会话时算一次的，会话
  // 空闲 30 分钟即释放，所以同一个人隔天回来就会重新生成一次。同步盘期间只要多进来一个
  // 文件，一旦提示词里写了文件数，几万 token 的历史缓存就白丢——所以数量一律不能进。
  test("stays byte-identical when only the index counts change", () => {
    const before = buildChatContext({ tempDir, index, pythonReady: true });
    const after = buildChatContext({
      tempDir,
      index: {
        ...index,
        totalFiles: index.totalFiles + 37,
        totalBytes: index.totalBytes + 8_000_000,
        generatedAt: index.generatedAt + 600_000,
        topLevel: index.topLevel.map((dir) => ({ ...dir, files: dir.files + 12 })),
      },
      pythonReady: true,
    });
    expect(after).toBe(before);
  });

  // 每位用户唯一不同的那一段排在最后，前面对全群逐字相同。
  test("keeps the only per-user value in the final section", () => {
    const mine = buildChatContext({ tempDir, index, pythonReady: true });
    const theirs = buildChatContext({
      tempDir: join("data", "groups", "group-a", "users", "+862", "tmp"),
      index,
      pythonReady: true,
    });
    const head = (prompt: string) => prompt.slice(0, prompt.indexOf("## 临时目录"));
    expect(head(mine)).toBe(head(theirs));
    expect(head(mine).length).toBeGreaterThan(mine.length * 0.8);
  });

  test("only claims the parsers are installed once they actually are", () => {
    const ready = buildChatContext({ tempDir, index, pythonReady: true });
    expect(ready).toContain("解析环境已备好");
    expect(ready).toContain("$PI_PYTHON");
    expect(ready).not.toContain("uv venv");

    const notReady = buildChatContext({ tempDir, index, pythonReady: false });
    expect(notReady).toContain("尚未就绪");
    expect(notReady).toContain("uv venv");
    expect(notReady).not.toContain("均已安装");
  });

  test("keeps the model from writing into the synced material tree", () => {
    const prompt = buildChatContext({ tempDir, index, pythonReady: true });
    expect(prompt).toContain("不要往里写任何东西");
    expect(prompt).toContain("不要写进资料库");
  });

  test("names the binary formats read cannot handle", () => {
    const prompt = buildChatContext({ tempDir, index, pythonReady: true });
    for (const ext of [".pptx", ".docx", ".xlsx", ".pdf"]) {
      expect(prompt).toContain(ext);
    }
    expect(prompt).toContain("read 工具读出来是乱码");
  });

  test("marks a truncated index instead of implying it is complete", () => {
    const prompt = buildChatContext({
      tempDir,
      index: { ...index, truncated: true },
      pythonReady: true,
    });
    expect(prompt).toContain("清单因文件过多被截断");
  });
});
