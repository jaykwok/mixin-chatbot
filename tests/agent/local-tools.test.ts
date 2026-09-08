import { archiveFixture as rm, testTempDir as tmpdir } from "../helpers/temp.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";

import { isAbsolute, join } from "node:path";
import { buildLocalTools } from "../../src/agent/local-tools.ts";
import { isPathInside } from "../../src/agent/paths.ts";
import { venvPythonPath } from "../../src/agent/python-toolchain.ts";

/** venv 与资料索引都住在 workspace 外面，和线上 <group>/ 下的布局保持一致。 */
const venvDirFor = (root: string) => join(root, "venv");
const indexPathFor = (root: string) => join(root, "index", "materials.md");

function toolsFor(
  root: string,
  workspace: string,
  userTemp: string,
  groupId = "group-a"
) {
  return buildLocalTools({
    workspaceDir: workspace,
    tempDir: userTemp,
    phone: "+8613800000000",
    groupId,
    venvDir: venvDirFor(root),
    materialsIndexPath: indexPathFor(root),
  });
}

describe("local Pi tool boundaries", () => {
  test("file tools read workspace but write only caller tmp", async () => {
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
      const tools = await toolsFor(root, workspace, userTemp);
      const read = tools.find((tool) => tool.name === "read")!;
      const write = tools.find((tool) => tool.name === "write")!;

      await expect(write.execute(
        "write-workspace",
        { path: "result.txt", content: "shared" },
        undefined,
        undefined,
        {} as never
      )).rejects.toThrow("只读");
      await writeFile(join(workspace, "result.txt"), "shared");
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
      ).rejects.toThrow("tmp");
      await expect(
        write.execute(
          "write-outside",
          { path: join(outside, "created.txt"), content: "no" },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow("tmp");
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
      const tools = await toolsFor(root, workspace, userTemp, groupId);
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
            'printf "%s" "$PI_CALLER_PHONE|$PI_GROUP_ID|$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_USER_TMP|$TMPDIR|$VIRTUAL_ENV|$UV_PROJECT_ENVIRONMENT|$PI_PYTHON|$PI_MATERIALS_INDEX|$PYTHONIOENCODING|$PYTHONUTF8|$LANG|$PYTHON_BASIC_REPL|$AI_AGENT|$PI_CODING_AGENT" > "$PI_USER_TMP/caller-env.txt"',
        },
        undefined,
        undefined,
        context
      );
      // venv 与索引都在 workspace 外：workspace 是同步盘镜像，写进去会被同步删掉。
      expect(envResult.content[0]).toMatchObject({ type: "text" });
      // 验证子进程实际收到的值，避免 Git Bash 启动时的 stderr 提示混入断言。
      expect(await readFile(join(userTemp, "caller-env.txt"), "utf8")).toBe(
        `+8613800000000|${groupId}|session-test|${join(root, "session.jsonl")}|provider-test|model-test|off|${userTemp}|${userTemp}|${venvDirFor(root)}|${venvDirFor(root)}|${venvPythonPath(venvDirFor(root))}|${indexPathFor(root)}|utf-8|1|C.UTF-8|1|pi|true`
      );
      expect(isPathInside(venvDirFor(root), workspace)).toBe(false);
      expect(isPathInside(indexPathFor(root), workspace)).toBe(false);

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
      expect(isPathInside(fullOutputPath!, await realpath(userTemp))).toBe(true);
      const text = outputResult.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      expect(text).toContain(`Full output: ${fullOutputPath}`);
      expect(text).toContain("line-2104");
      expect(text).toContain("Showing");
      expect((await readFile(fullOutputPath!, "utf8")).includes("line-2104")).toBe(
        true
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Producing 2105 lines through a real shell runs past bun's 5s default on
    // Windows/Git Bash; the loop is what makes the output truncate at all.
  }, 20_000);

  test("bash writes caller tmp without a custom mutation protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-bash-tmp-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    await Promise.all([mkdir(workspace), mkdir(userTemp)]);

    try {
      const tools = await toolsFor(root, workspace, userTemp);
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
        },
        undefined,
        undefined,
        context
      );
      expect(await readFile(scratch, "utf8")).toBe("extracted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  test("read reaches the material index outside the workspace but cannot write there", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-index-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    await Promise.all([
      mkdir(workspace),
      mkdir(userTemp),
      mkdir(join(root, "index")),
    ]);
    await writeFile(indexPathFor(root), "产品资料/手册.pptx | 2.0 MB | 2026-01-01", "utf8");

    try {
      const tools = await toolsFor(root, workspace, userTemp);
      const read = tools.find((tool) => tool.name === "read")!;
      const write = tools.find((tool) => tool.name === "write")!;

      // 索引不能放进 workspace（同步盘镜像），但模型必须读得到它，否则每次查清单
      // 都要先吃一次「只能访问」的拒绝，白白浪费一轮。
      const result = await read.execute(
        "read-index",
        { path: indexPathFor(root) },
        undefined,
        undefined,
        {} as never
      );
      expect(
        result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n")
      ).toContain("产品资料/手册.pptx");

      // 只读放行到此为止：索引由适配层生成，模型不该改写它。edit 走的是另一条
      // operations 分支（access 而非 readFile），必须一起挡住。
      await expect(
        write.execute(
          "write-index",
          { path: indexPathFor(root), content: "tampered" },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow("tmp");
      const edit = tools.find((tool) => tool.name === "edit")!;
      await expect(
        edit.execute(
          "edit-index",
          {
            path: indexPathFor(root),
            edits: [{ oldText: "产品资料/手册.pptx", newText: "伪造.pptx" }],
          } as never,
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow("tmp");
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
      const tools = await toolsFor(root, workspace, userTemp);
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
        "tmp"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
