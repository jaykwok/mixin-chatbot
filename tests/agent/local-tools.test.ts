import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildLocalTools } from "../../src/agent/local-tools.ts";
import { isPathInside } from "../../src/agent/paths.ts";

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
    const groupId = "group-a'; printf injected; #";
    await Promise.all([mkdir(workspace), mkdir(userTemp)]);

    try {
      const tools = await buildLocalTools(
        workspace,
        userTemp,
        "+8613800000000",
        groupId
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
            'printf "%s" "$PI_CALLER_PHONE|$PI_GROUP_ID|$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_USER_TMP|$TMPDIR|$VIRTUAL_ENV|$UV_PROJECT_ENVIRONMENT|$PYTHONIOENCODING|$AI_AGENT|$PI_CODING_AGENT"',
          mutates: [],
        },
        undefined,
        undefined,
        context
      );
      expect(envResult.content[0]).toMatchObject({
        type: "text",
        text: `+8613800000000|${groupId}|session-test|${join(root, "session.jsonl")}|provider-test|model-test|off|${userTemp}|${userTemp}|${join(workspace, ".venv")}|${join(workspace, ".venv")}|utf-8|pi|true`,
      });

      const outputResult = await bash.execute(
        "bash-output",
        {
          command:
            'i=0; while [ "$i" -lt 2105 ]; do echo "line-$i"; i=$((i+1)); done',
          mutates: [],
        },
        undefined,
        undefined,
        context
      );
      const fullOutputPath = (outputResult.details as { fullOutputPath?: string })
        .fullOutputPath;
      expect(fullOutputPath).toBeString();
      expect(isAbsolute(fullOutputPath!)).toBe(true);
      expect(isPathInside(fullOutputPath!, await realpath(userTemp))).toBe(true);
      expect((await readFile(fullOutputPath!, "utf8")).includes("line-2104")).toBe(
        true
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Producing 2105 lines through a real shell runs past bun's 5s default on
    // Windows/Git Bash; the loop is what makes the output truncate at all.
  }, 20_000);

  test("bash mutates shares the same file FIFO with write", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-bash-lock-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    await Promise.all([mkdir(workspace), mkdir(userTemp)]);
    await writeFile(join(workspace, "shared.txt"), "initial", "utf8");

    try {
      const tools = await buildLocalTools(
        workspace,
        userTemp,
        "+8613800000000",
        "group-a"
      );
      const bash = tools.find((tool) => tool.name === "bash")!;
      const write = tools.find((tool) => tool.name === "write")!;
      const context = {
        sessionManager: {
          getSessionId: () => "session-test",
          getSessionFile: () => join(root, "session.jsonl"),
        },
        model: { provider: "provider-test", id: "model-test" },
        thinkingLevel: "off",
      } as never;

      const bashRun = bash.execute(
        "bash-locked-write",
        {
          command:
            'printf "started" > marker.txt; sleep 0.2; printf "from-bash" > shared.txt',
          mutates: ["marker.txt", "shared.txt"],
        },
        undefined,
        undefined,
        context
      );

      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if (
            (await readFile(join(workspace, "marker.txt"), "utf8")) ===
            "started"
          ) {
            break;
          }
        } catch {
          // Bash has not started yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(await readFile(join(workspace, "marker.txt"), "utf8")).toBe(
        "started"
      );

      const writeRun = write.execute(
        "write-after-bash",
        { path: "shared.txt", content: "from-write" },
        undefined,
        undefined,
        {} as never
      );
      await Promise.all([bashRun, writeRun]);
      expect(await readFile(join(workspace, "shared.txt"), "utf8")).toBe(
        "from-write"
      );

      // A missing or malformed declaration must fall back to the workspace-wide
      // lock rather than throwing away the tool call.
      const missing = await bash.execute(
        "bash-missing-mutates",
        { command: "pwd" } as never,
        undefined,
        undefined,
        context
      );
      expect(missing.content[0]).toMatchObject({ type: "text" });
      expect(bash.prepareArguments?.({ command: "pwd" })).toMatchObject({
        mutates: ["."],
      });
      expect(
        bash.prepareArguments?.({ command: "pwd", mutates: "output.txt" })
      ).toMatchObject({ mutates: ["."] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bash may declare mutations in the caller tmp without being blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-bash-tmp-"));
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

      // The regression: intermediates belong in the caller's tmp, and declaring
      // them there used to terminate the whole turn.
      const scratch = join(userTemp, "extracted.txt");
      await bash.execute(
        "bash-temp-mutation",
        {
          command: 'printf "extracted" > "$PI_USER_TMP/extracted.txt"',
          mutates: [scratch],
        },
        undefined,
        undefined,
        context
      );
      expect(await readFile(scratch, "utf8")).toBe("extracted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("read detects images with Pi's sniffer, still behind the path guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-image-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(userTemp), mkdir(outside)]);

    // 1x1 transparent PNG: real signature plus a valid IHDR/IDAT/IEND chain.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    // Signature only: our old 12-byte sniffer called this image/png, which then
    // reached the model as a broken image block. Pi's validates the IHDR chunk.
    const fakePng = Buffer.concat([
      png.subarray(0, 8),
      Buffer.from("not really a png", "utf8"),
    ]);

    try {
      const tools = await buildLocalTools(
        workspace,
        userTemp,
        "+8613800000000",
        "group-a"
      );
      const read = tools.find((tool) => tool.name === "read")!;
      const readText = async (path: string): Promise<string> => {
        const result = await read.execute(
          `read-${path}`,
          { path },
          undefined,
          undefined,
          {} as never
        );
        return result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
      };

      await writeFile(join(workspace, "chart.png"), png);
      await writeFile(join(workspace, "fake.png"), fakePng);
      await writeFile(join(outside, "secret.png"), png);

      expect(await readText(join(workspace, "chart.png"))).toContain(
        "Read image file [image/png]"
      );
      expect(await readText(join(workspace, "fake.png"))).not.toContain(
        "Read image file"
      );
      await expect(readText(join(outside, "secret.png"))).rejects.toThrow(
        "只能访问"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
