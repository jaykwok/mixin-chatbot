import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { tempFixture } from "../helpers/temp.ts";

test.each(["first", "existing", "manual"])("configure %s flow writes reviewed metadata", async (mode) => {
  const files = await tempFixture("pi-configure-");
  try {
    const source = getBuiltinModels("openai").find((model) => model.id === "gpt-5.2")!;
    expect(source).toBeDefined();
    const modelsPath = join(files.root, "data/config/models.json");
    if (mode === "existing") {
      await mkdir(join(files.root, "data/config"), { recursive: true });
      await writeFile(modelsPath, JSON.stringify({ providers: { openai: {
        baseUrl: "https://example.com/v1", compat: { supportsMaxOutputTokens: false },
        models: [{ id: source.id, input: ["text", "image"], contextWindow: 12345, maxTokens: 2345,
          reasoning: false, cost: { input: 7, output: 8, cacheRead: 9, cacheWrite: 10 } }],
      } } }));
    }
    const preload = join(files.root, "prompts.ts");
    // 子进程只替换交互控件，实际运行 configure 入口并读回它落盘的完整配置。
    // mock 限制在子进程，不污染同进程里的 SDK 或其他测试。
    await writeFile(preload, `
      import { mock } from "bun:test";
      const mode = ${JSON.stringify(mode)};
      const noop = () => {};
      mock.module(${JSON.stringify(import.meta.resolve("@clack/prompts"))}, () => ({
        cancel: noop, intro: noop, note: noop, outro: noop, isCancel: () => false,
        log: { info: noop, warn: (message) => console.log(message) },
        password: async () => "test-only",
        select: async (options) => options.initialValue,
        confirm: async (options) => {
          if (options.message.startsWith("服务支持")) return true;
          if (mode === "manual" && options.message === "模型支持图片输入？") return true;
          return options.initialValue;
        },
        text: async (options) => {
          if (mode === "manual" && options.message === "模型 id") return "unknown-test-alias";
          if (mode === "manual" && options.message.includes("价格（")) return "1.5";
          return options.initialValue ?? options.defaultValue;
        },
      }));
    `);
    const proc = Bun.spawn([process.execPath, "--preload", preload,
      fileURLToPath(new URL("../../scripts/config/configure.ts", import.meta.url))], {
      cwd: files.root, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const doc = JSON.parse(await readFile(modelsPath, "utf8"));
    const provider = doc.providers.openai;
    const model = provider.models[0];
    expect(provider).not.toHaveProperty("compat");
    expect(model.compat.supportsMaxOutputTokens).toBe(true);
    if (mode === "first") {
      expect(model).toMatchObject({ input: source.input, cost: source.cost, contextWindow: source.contextWindow, maxTokens: source.maxTokens });
    } else if (mode === "existing") {
      expect(model).toMatchObject({ input: ["text", "image"], contextWindow: 12345, maxTokens: 2345,
        cost: { input: 7, output: 8, cacheRead: 9, cacheWrite: 10 } });
    } else {
      expect(model).toMatchObject({ input: ["text", "image"],
        cost: { input: 1.5, output: 1.5, cacheRead: 1.5, cacheWrite: 1.5 } });
      expect(stdout).toContain("未精确匹配");
    }
  } finally {
    await files.cleanup();
  }
});
