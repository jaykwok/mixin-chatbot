import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildLocalTools } from "../../src/agent/local-tools.ts";

describe("local Pi tool boundaries", () => {
  test("file tools allow workspace and caller tmp but reject other paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-tools-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(workspace),
      mkdir(userTemp),
      mkdir(outside),
    ]);

    try {
      const tools = await buildLocalTools(
        workspace,
        userTemp,
        "+8613800000000",
        "group-a"
      );
      const read = tools.find((tool) => tool.name === "read")!;
      const write = tools.find((tool) => tool.name === "write")!;

      await write.execute(
        "write-workspace",
        { path: "result.txt", content: "shared" },
        undefined,
        undefined,
        {} as never
      );
      await write.execute(
        "write-temp",
        { path: join(userTemp, "scratch.txt"), content: "scratch" },
        undefined,
        undefined,
        {} as never
      );
      expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("shared");
      expect(await readFile(join(userTemp, "scratch.txt"), "utf8")).toBe("scratch");

      const outsideFile = join(outside, "secret.txt");
      await writeFile(outsideFile, "secret", "utf8");
      await expect(
        read.execute(
          "read-outside",
          { path: outsideFile },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow("只能访问");
      await expect(
        write.execute(
          "write-outside",
          { path: join(outside, "created.txt"), content: "no" },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow("只能访问");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bash receives Pi/caller metadata and relocates truncated output", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-bash-"));
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

      const envResult = await bash.execute(
        "bash-env",
        {
          command:
            'printf "%s" "$PI_CALLER_PHONE|$PI_GROUP_ID|$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_USER_TMP|$TMPDIR"',
        },
        undefined,
        undefined,
        context
      );
      expect(envResult.content[0]).toMatchObject({
        type: "text",
        text: `+8613800000000|group-a|session-test|${join(root, "session.jsonl")}|provider-test|model-test|off|${userTemp}|${userTemp}`,
      });

      const outputResult = await bash.execute(
        "bash-output",
        {
          command:
            'i=0; while [ "$i" -lt 2105 ]; do echo "line-$i"; i=$((i+1)); done',
        },
        undefined,
        undefined,
        context
      );
      const fullOutputPath = (outputResult.details as { fullOutputPath?: string })
        .fullOutputPath;
      expect(fullOutputPath).toBeString();
      expect(isAbsolute(fullOutputPath!)).toBe(true);
      expect(fullOutputPath!.startsWith(userTemp)).toBe(true);
      expect((await readFile(fullOutputPath!, "utf8")).includes("line-2104")).toBe(
        true
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
