// Pi 的 bash 工具默认不限时，挂死的命令会永久占住一轮 prompt：用户只收到「正在思考」，
// 之后的消息全部退化成 steer，会话槽位也不再释放。这里验证适配层注入的默认上限确实生效。
// 配置在模块加载时读环境变量，因此必须先设置再动态导入。bun test 的模块注册表在同一次
// 运行里是共用的，所以这只在本文件先于其他导入 config 的测试执行时生效——下面第一条断言
// 就是为此而写：万一将来顺序变了，它会立刻报错，而不是让测试挂在一分钟的 sleep 上。
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BOT_BASH_TIMEOUT = "10";
const { BASH_DEFAULT_TIMEOUT } = await import("../../src/core/config.ts");
const { buildLocalTools } = await import("../../src/agent/local-tools.ts");

describe("bash default timeout", () => {
  test("a command with no declared timeout is stopped instead of hanging the turn", async () => {
    expect(BASH_DEFAULT_TIMEOUT).toBe(10);
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-bash-timeout-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    await Promise.all([mkdir(workspace), mkdir(userTemp)]);

    try {
      const tools = await buildLocalTools(
        workspace,
        userTemp,
        "+8613800000000",
        "group-a"
      );
      const bash = tools.find((tool) => tool.name === "bash")!;
      const context = {
        sessionManager: {
          getSessionId: () => "session-test",
          getSessionFile: () => join(root, "session.jsonl"),
        },
        model: { provider: "provider-test", id: "model-test" },
        thinkingLevel: "off",
      } as never;

      const start = Date.now();
      const run = bash.execute(
        "bash-no-timeout",
        { command: "sleep 60", mutates: [] },
        undefined,
        undefined,
        context
      );
      await expect(run).rejects.toThrow(
        `Command timed out after ${BASH_DEFAULT_TIMEOUT} seconds`
      );
      expect(Date.now() - start).toBeLessThan(30_000);

      // 模型显式声明的 timeout 仍然优先。
      const explicit = bash.execute(
        "bash-explicit-timeout",
        { command: "sleep 60", timeout: 1, mutates: [] },
        undefined,
        undefined,
        context
      );
      await expect(explicit).rejects.toThrow("Command timed out after 1 seconds");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
