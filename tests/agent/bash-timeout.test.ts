import { archiveFixture as rm, testTempDir as tmpdir } from "../helpers/temp.ts";
// Pi 的 bash 工具默认不限时，挂死的命令会永久占住一轮 prompt：用户只收到「正在思考」，
// 之后的消息全部退化成 steer，会话槽位也不再释放。这里验证适配层注入的默认上限确实生效。
// 配置在模块加载时读取：用独立测试进程设置环境，不能依赖各平台的文件发现顺序。
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";

import { join } from "node:path";
import { fileURLToPath } from "node:url";

describe("bash default timeout", () => {
  test("a command with no declared timeout is stopped instead of hanging the turn", async () => {
    if (process.env.BASH_TIMEOUT_TEST_CHILD !== "1") {
      const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
        cwd: process.cwd(), env: { ...process.env, BOT_BASH_TIMEOUT: "10", BASH_TIMEOUT_TEST_CHILD: "1" },
        stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      const timer = setTimeout(() => child.kill(), 35000);
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, stdout + "\n" + stderr).toBe(0);
      } finally { clearTimeout(timer); child.kill(); await child.exited; }
      return;
    }
    const { BASH_DEFAULT_TIMEOUT } = await import("../../src/core/config.ts");
    const { buildLocalTools } = await import("../../src/agent/local-tools.ts");
    expect(BASH_DEFAULT_TIMEOUT).toBe(10);
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-bash-timeout-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    await Promise.all([mkdir(workspace), mkdir(userTemp)]);

    try {
      const tools = await buildLocalTools({
        workspaceDir: workspace,
        tempDir: userTemp,
        phone: "+8613800000000",
        groupId: "group-a",
        venvDir: join(root, "venv"),
        materialsIndexPath: join(root, "index", "materials.md"),
      });
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
