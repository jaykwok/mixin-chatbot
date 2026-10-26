import { archiveFixture as rm, testTempDir as tmpdir } from "../helpers/temp.ts";
// Pi 的 bash 工具默认不限时，挂死的命令会永久占住一轮 prompt：用户只收到「正在思考」，
// 之后的消息全部退化成 steer，会话槽位也不再释放。这里验证适配层注入的默认上限确实生效。
// 配置在模块加载时读取：用独立测试进程设置环境，不能依赖各平台的文件发现顺序。
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { groupScope } from "../../src/core/layout.ts";

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
    const { createMemberEnv } = await import("../../src/durable/member-env.ts");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    expect(BASH_DEFAULT_TIMEOUT).toBe(10);
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-bash-timeout-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    await Promise.all([mkdir(workspace), mkdir(userTemp)]);

    try {
      const env = await createMemberEnv({ workspaceDir: workspace, tempDir: userTemp,
        phone: "+8613800000000", scope: groupScope("group-a"), venvDir: join(root, "venv"), materialsIndexPath: join(root, "index/materials.md") });
      for (const seconds of [undefined, 1]) {
        const start = Date.now();
        const result = await env.exec("sleep 60", { timeout: seconds }, BACKGROUND_CONTEXT);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("timeout");
          expect(result.error.message).toContain(`Command timed out after ${seconds ?? BASH_DEFAULT_TIMEOUT} seconds`);
        }
        expect(Date.now() - start).toBeLessThan((seconds ?? BASH_DEFAULT_TIMEOUT) * 1000 + 7000);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
