// The four official tools on the Durable engine (D2-2, src/durable/tools.ts), driven by faux tool calls through a real
// group Harness wired as the service will be (the door first). Real shells and files under tmp/; no network.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Message } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  configure, type Conversation, DEFAULT_PROGRESS_POLICY, LiveDoc, type ModelRef, type ProgressPolicy, type Storage,
} from "@earendil-works/pi-durable";
import { nativeBaseTools, bashToolNote } from "../../src/durable/base-tools.ts";
import { isPathInside } from "../../src/contracts/paths.ts";
import { IdentityDoc, memberConversation } from "../../src/durable/identity.ts";
import { baseExtension, baseTools, type BaseToolsOptions, memberPlaces, memberRegistration } from "../../src/durable/tools.ts";
import { clearRunning, markRunning } from "../../src/durable/running-requests.ts";
import { runProcess, timedCommand } from "../../src/core/process.ts";
import { log } from "../../src/core/log.ts";
import { type GroupHarness, openGroupHarness, PROJECT_PROGRESS as PROGRESS } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { appLayout, groupScope } from "../../src/core/layout.ts";

const fixture = await tempFixture("durable-tools-");
afterAll(() => fixture.cleanup());
const GROUP = "group-a", SPACE = groupScope(GROUP);
const ALICE = "+8613800000001";
const BOB = "+8613800000002";
let counter = 0;

type Group = {
  opened: GroupHarness;
  faux: ReturnType<typeof fauxProvider>;
  model: ModelRef;
  tools: BaseToolsOptions;
  models: ReturnType<typeof createModels>;
  close(): Promise<void>;
};

/**
 * A group-a Harness with `mixin.base`; `toolsGroup` builds the tools for another group. Data directories have Chinese names.
 * `door: false` leaves out the request door, which refuses a conversation without a member identity before any tool runs.
 */
async function openGroup(options: {
  vision?: boolean; toolsGroup?: string; door?: false; progress?: ProgressPolicy; storage?: (storage: Storage) => Storage;
} = {}): Promise<Group> {
  const n = ++counter;
  const faux = fauxProvider({ tokenSize: { min: 50, max: 50 }, ...(options.vision === false ? { models: [{ id: "text-only", input: ["text"] }] } : {}) });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const tools: BaseToolsOptions = { layout: appLayout(join(fixture.root, `群数据-${n}`)), scope: groupScope(options.toolsGroup ?? GROUP) };
  const opened = await openGroupHarness(join(fixture.root, `db-${n}.sqlite`), models, {
    group: GROUP, door: options.door, extensions: [baseExtension(tools)], storage: options.storage,
    settings: { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(options.progress === undefined ? {} : { progress: options.progress }) },
  });
  return { opened, faux, model: { provider: model.provider, modelId: model.id }, tools, models, close: () => opened.close() };
}

async function member(group: Group, phone: string): Promise<Conversation> {
  return (await memberConversation(group.opened.harness, SPACE, phone, { model: group.model }, context)).conversation;
}

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError: boolean; text: string; content: Content[]; details?: Record<string, unknown> };
type Turn = { settled: { status: string; reason?: string }; results: Record<string, Result>; outcomes: Record<string, string>; request: Message[] };

/** One turn: the model makes `calls`, then answers. Results and tool task outcomes by call id; the follow-up request. */
async function turn(group: Group, conversation: Conversation, calls: ReturnType<typeof fauxToolCall>[], during?: () => Promise<void>): Promise<Turn> {
  let request: Message[] = [];
  group.faux.setResponses([
    fauxAssistantMessage(calls, { stopReason: "toolUse" }),
    (transcript) => { request = transcript.messages; return fauxAssistantMessage("好的"); },
  ]);
  const submission = await conversation.submit({ type: "input", content: "处理一下" }, context);
  await during?.();
  const settled = await submission.wait(context) as unknown as Turn["settled"];
  const ids = new Set(calls.map((call) => call.id));
  const results: Record<string, Result> = {};
  for (const entry of (await conversation.entries({}, 1000, undefined, context)).items) {
    const message = entry.model?.[0] as { toolCallId?: string; isError: boolean; content: Content[]; details?: Record<string, unknown> } | undefined;
    if (entry.kind !== "pi.tool-result" || message?.toolCallId === undefined || !ids.has(message.toolCallId)) continue;
    results[message.toolCallId] = {
      isError: message.isError, content: message.content, details: message.details, text: message.content.map((item) => item.text ?? "").join(""),
    };
  }
  const outcomes: Record<string, string> = {};
  const tasks = await group.opened.harness.commit((tx) => tx.scanTasks({ kind: "pi.tool" }, 1000), context);
  for (const task of tasks.items) {
    const callId = (task.input as { callId: string }).callId;
    if (ids.has(callId)) outcomes[callId] = task.state.status === "terminal" ? task.state.outcome.status : task.state.status;
  }
  return { settled, results, outcomes, request };
}

async function until(probe: () => Promise<boolean> | boolean, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const posix = (path: string) => path.replaceAll("\\", "/");

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
    let crc = ~0;
    for (const byte of body) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(~crc >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 120);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}

describe("Durable base tools", () => {
  test("registrations: the catalogue equals the member's tools; replay, output limits, constrained sampling", async () => {
    const options: BaseToolsOptions = { layout: appLayout(join(fixture.root, "目录")), scope: SPACE };
    const registered = baseTools(options);
    expect(registered.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
    const limits = { maxBytes: 64 * 1024, maxLines: 2200 };
    expect(Object.fromEntries(registered.map((tool) => [tool.name, { replay: tool.replay, outputLimits: tool.outputLimits }]))).toEqual({
      read: { replay: "safe", outputLimits: limits },
      bash: { replay: "unsafe", outputLimits: { ...limits, retain: "tail" } },
      edit: { replay: "unsafe", outputLimits: limits },
      write: { replay: "unsafe", outputLimits: limits },
    });

    const places = memberPlaces(options, SPACE, ALICE);
    for (const dir of [places.workspaceDir, places.tempDir]) await mkdir(dir, { recursive: true });
    const own = nativeBaseTools();
    const shape = (tool: (typeof registered)[number] | (typeof own)[number]) => ({
      name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)),
      constrainedSampling: tool.constrainedSampling, executionMode: tool.executionMode, prepareArguments: typeof tool.prepareArguments,
    });
    expect(registered.map(shape)).toEqual(own.map(shape));
    expect(registered.map((tool) => tool.constrainedSampling)).toEqual(own.map(tool => tool.constrainedSampling));
    expect(registered[1]!.description.endsWith(bashToolNote())).toBe(true);
    // Without rootless tasks nothing is isolated: no isolation note and no input_paths; with them, both.
    expect(registered[1]!.description).not.toContain("input_paths");
    expect(JSON.stringify(registered[1]!.parameters)).not.toContain("input_paths");
    expect(bashToolNote(true)).toContain("input_paths");
    // edit repairs the legacy single-replacement form the same way.
    const legacy = { path: "a.txt", oldText: "甲", newText: "乙" };
    expect(registered[2]!.prepareArguments!(legacy)).toEqual(own[2]!.prepareArguments!(legacy) as never);
  });

  test("read: a PNG reaches a vision model as an image, a text-only model gets the official note instead; the request offers the four declarations", async () => {
    for (const vision of [true, false]) {
      const group = await openGroup({ vision });
      try {
        const conversation = await member(group, ALICE);
        const places = memberPlaces(group.tools, SPACE, ALICE);
        await mkdir(join(places.workspaceDir, "资料"), { recursive: true });
        await writeFile(join(places.workspaceDir, "资料", "联系表.png"), png(8, 6));
        const id = `png_${vision}`;
        const t = await turn(group, conversation, [fauxToolCall("read", { path: "资料/联系表.png" }, { id })]);
        const result = t.results[id]!;
        // The official read keeps the image in its result and notes a text-only model; pi-ai leaves it out of the request.
        expect(result.isError).toBe(false);
        expect(result.content.some((item) => item.type === "image")).toBe(true);
        expect(result.text.includes("does not support images")).toBe(!vision);
        const payload = JSON.stringify(convertMessages({ ...group.faux.getModel(), api: "openai-completions" } as never, { messages: t.request } as never, {} as never));
        expect(payload.includes("image_url")).toBe(vision);
        expect(getCurrentTools(t.request).map((tool) => [tool.name, tool.constrainedSampling]))
          .toEqual(["read", "bash", "edit", "write"].map((name) => [name, undefined]));
      } finally { await group.close(); }
    }
  }, 30_000);

  test("read: the connected Photon processor shrinks oversized images without changing the source", async () => {
    const group = await openGroup({ vision: true });
    try {
      const places = memberPlaces(group.tools, SPACE, ALICE);
      await mkdir(places.workspaceDir, { recursive: true });
      const original = png(3000, 1000), path = join(places.workspaceDir, "wide.png");
      await writeFile(path, original);
      const t = await turn(group, await member(group, ALICE), [fauxToolCall("read", { path }, { id: "resize" })]);
      expect(t.results.resize!.isError).toBe(false);
      const image = t.results.resize!.content.find(item => item.type === "image")!;
      expect(image.mimeType).toBe("image/png");
      const bytes = Buffer.from(image.data!, "base64");
      expect(bytes.readUInt32BE(16)).toBeLessThan(3000);
      expect(bytes.readUInt32BE(20)).toBeLessThan(1000);
      expect(await readFile(path)).toEqual(original);
    } finally { await group.close(); }
  }, 30_000);

  test("read: a large file gets the official truncation and no second one from the Harness", async () => {
    const group = await openGroup();
    try {
      const conversation = await member(group, ALICE);
      const places = memberPlaces(group.tools, SPACE, ALICE);
      await mkdir(places.workspaceDir, { recursive: true });
      await writeFile(join(places.workspaceDir, "大文件.txt"), Array.from({ length: 4000 }, (_, i) => `第${i + 1}行 ${"内容".repeat(10)}`).join("\n"));
      const t = await turn(group, conversation, [fauxToolCall("read", { path: "大文件.txt" }, { id: "large" })]);
      expect(t.results.large!.isError).toBe(false);
      expect(t.results.large!.text).toContain("offset=");
      expect(t.results.large!.text).toContain("<harness>");
    } finally { await group.close(); }
  });

  test("paths: workspace and index read-only, only the caller's tmp writable; another member's tmp, outside paths and links refused", async () => {
    const group = await openGroup();
    try {
      const alice = await member(group, ALICE);
      const a = memberPlaces(group.tools, SPACE, ALICE);
      const b = memberPlaces(group.tools, SPACE, BOB);
      const outside = join(fixture.root, `外部-${counter}`);
      for (const dir of [a.workspaceDir, a.tempDir, b.tempDir, dirname(a.indexPath), outside]) await mkdir(dir, { recursive: true });
      await writeFile(join(a.workspaceDir, "资料.txt"), "共享资料");
      await writeFile(a.indexPath, "资料.txt | 1 KB");
      await writeFile(join(b.tempDir, "私有.txt"), "bob");
      await writeFile(join(outside, "secret.txt"), "secret");
      // A junction needs no privilege on Windows; elsewhere it is a directory symlink.
      await symlink(a.workspaceDir, join(a.tempDir, "链接"), "junction");
      const t = await turn(group, alice, [
        fauxToolCall("read", { path: "资料.txt" }, { id: "read_workspace" }),
        fauxToolCall("read", { path: a.indexPath }, { id: "read_index" }),
        fauxToolCall("write", { path: join(a.tempDir, "草稿", "结果.txt"), content: "结果" }, { id: "write_own_tmp" }),
        fauxToolCall("write", { path: "新文件.txt", content: "x" }, { id: "write_workspace" }),
        fauxToolCall("edit", { path: a.indexPath, edits: [{ oldText: "资料.txt", newText: "伪造" }] }, { id: "edit_index" }),
        fauxToolCall("read", { path: join(b.tempDir, "私有.txt") }, { id: "read_other_tmp" }),
        fauxToolCall("write", { path: join(b.tempDir, "写入.txt"), content: "x" }, { id: "write_other_tmp" }),
        fauxToolCall("read", { path: join(outside, "secret.txt") }, { id: "read_outside" }),
        fauxToolCall("write", { path: join(a.tempDir, "链接", "经链接.txt"), content: "x" }, { id: "write_through_link" }),
      ]);
      const errors = Object.fromEntries(Object.entries(t.results).map(([id, result]) => [id, result.isError]));
      expect(errors).toEqual({
        read_workspace: false, read_index: false, write_own_tmp: false,
        write_workspace: true, edit_index: true, read_other_tmp: true, write_other_tmp: true, read_outside: true, write_through_link: true,
      });
      expect(t.results.read_workspace!.text).toContain("共享资料");
      expect(t.results.write_workspace!.text).toContain("只读");
      expect(await readFile(join(a.tempDir, "草稿", "结果.txt"), "utf8")).toBe("结果");
      expect(await readFile(a.indexPath, "utf8")).toBe("资料.txt | 1 KB");
      expect(existsSync(join(a.workspaceDir, "新文件.txt"))).toBe(false);
      expect(existsSync(join(a.workspaceDir, "经链接.txt"))).toBe(false);
      expect(existsSync(join(b.tempDir, "写入.txt"))).toBe(false);
      expect(new Set(Object.values(t.outcomes))).toEqual(new Set(["completed", "failed"]));
    } finally { await group.close(); }
  }, 30_000);

  test("identity: each member's bash gets its own phone, space and tmp, and no Pi session variables", async () => {
    const group = await openGroup();
    try {
      const command = 'printf "%s" "$PI_CALLER_PHONE|$PI_SPACE|$PI_USER_TMP|$TMPDIR|${PI_SESSION_ID-unset}|${PI_SESSION_FILE-unset}|${PI_PROVIDER-unset}|${PI_MODEL-unset}|${PI_REASONING_LEVEL-unset}" > "$PI_USER_TMP/env.txt"';
      for (const phone of [ALICE, BOB]) {
        const t = await turn(group, await member(group, phone), [fauxToolCall("bash", { command }, { id: `env_${phone}` })]);
        expect(t.results[`env_${phone}`]!.isError).toBe(false);
        const places = memberPlaces(group.tools, SPACE, phone);
        expect(await readFile(join(places.tempDir, "env.txt"), "utf8"))
          .toBe(`${phone}|group:${GROUP}|${places.tempDir}|${places.tempDir}|unset|unset|unset|unset|unset`);
      }
    } finally { await group.close(); }
    // Two shells; a Bun process's first spawn takes about 3 s under this host's security software.
  }, 60_000);

  test("identity: tools of another group, a conversation without an identity, or one with this group but no phone, run nothing", async () => {
    const marker = join(fixture.root, `marker-${counter}.txt`);
    const call = (id: string) => fauxToolCall("bash", { command: `echo ran > '${posix(marker)}'` }, { id });
    const other = await openGroup({ toolsGroup: "group-b" });
    try {
      const t = await turn(other, await member(other, ALICE), [call("other_group")]);
      expect(t.results.other_group).toMatchObject({ isError: true });
      expect(t.results.other_group!.text).toContain("不属于本空间");
      expect(t.outcomes.other_group).toBe("failed");
      expect(existsSync(other.tools.layout.tmp)).toBe(false);
    } finally { await other.close(); }

    const group = await openGroup({ door: false });
    try {
      // Never written: the snapshot is undefined. Written with this group and no phone: every such conversation would
      // share one tmp, so it is refused as well.
      for (const [label, space] of [["no_identity", undefined], ["no_phone", `group:${GROUP}`]] as const) {
        const id = await group.opened.harness.commit(async (tx) => {
          const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, record.id, { model: group.model, thinkingLevel: "off" });
          if (space !== undefined) (await tx.doc(IdentityDoc, record.id)).space = space;
          return record.id;
        }, context);
        if (space !== undefined) expect(await group.opened.harness.snapshot(IdentityDoc, id, context)).toMatchObject({ space, phone: "" });
        const t = await turn(group, (await group.opened.harness.conversation(id, context))!, [call(label)]);
        expect(t.results[label]).toMatchObject({ isError: true });
        expect(t.results[label]!.text).toContain("没有成员身份");
        expect(t.outcomes[label]).toBe("failed");
      }
      expect(existsSync(group.tools.layout.tmp)).toBe(false);
    } finally { await group.close(); }
    expect(existsSync(marker)).toBe(false);
  });

  test("bash: output, non-zero exit and timeout are results; a large output's full file moves into the caller's tmp; each command logs its timing with the running task", async () => {
    const group = await openGroup();
    const lines: string[] = [];
    const info = spyOn(log, "info").mockImplementation(line => { if (line.startsWith("命令耗时")) lines.push(line); });
    markRunning(SPACE, ALICE, "abcd1234");
    try {
      const t = await turn(group, await member(group, ALICE), [
        fauxToolCall("bash", { command: "echo 你好; echo 第二行" }, { id: "ok" }),
        fauxToolCall("bash", { command: "echo 失败前; exit 3" }, { id: "exit" }),
        fauxToolCall("bash", { command: "sleep 30", timeout: 2 }, { id: "timeout" }),
        fauxToolCall("bash", { command: `awk 'BEGIN { for (i = 0; i < 3000; i++) print "line-" i }'` }, { id: "large" }),
      ]);
      expect(t.results.ok).toMatchObject({ isError: false });
      expect(t.results.ok!.text).toContain("你好\n第二行");
      // Running updates are not forwarded: Durable would keep the last as the details of a result without its own.
      expect(t.results.ok!.details).toBeUndefined();
      expect(t.results.exit).toMatchObject({ isError: true });
      expect(t.results.exit!.text).toContain("Command exited with code 3");
      expect(t.results.timeout).toMatchObject({ isError: true });
      expect(t.results.timeout!.text).toContain("Command timed out after 2 seconds");
      const large = t.results.large!;
      const full = /Full output: ([^\r\n<]+)/.exec(large.text)?.[1]!.trim()!;
      expect(isPathInside(full, await realpath(memberPlaces(group.tools, SPACE, ALICE).tempDir))).toBe(true);
      expect(large.text).toContain(`Full output: ${full}`);
      expect(large.text).toContain("<harness>");
      const file = await readFile(full, "utf8");
      expect(file.startsWith("line-0\n") && file.includes("line-2999")).toBe(true);
      // coding-agent 1.0.3 creates its output files private (0600, new); the move into the caller's tmp keeps that.
      if (process.platform !== "win32") expect((await stat(full)).mode & 0o777).toBe(0o600);
      expect(new Set(Object.values(t.outcomes))).toEqual(new Set(["completed", "failed"]));
      const deadline = Date.now() + 5000;
      while (lines.length < 4 && Date.now() < deadline) await Bun.sleep(10);
      const prefix = `命令耗时 - 群 ${GROUP}, 用户: ${ALICE}, 任务: abcd1234, 工具: bash#`;
      expect(lines).toHaveLength(4);
      for (const line of lines) expect(line.startsWith(prefix)).toBe(true);
      expect(lines.map(line => /结果: ([^,]+)/.exec(line)?.[1]).sort()).toEqual(["超时", "退出码 0", "退出码 0", "退出码 3"]);
    } finally { info.mockRestore(); clearRunning(SPACE, ALICE, "abcd1234"); await group.close(); }
  }, 60_000);

  test("timing: a tool keeps its original request even when the member advances before a later command", async () => {
    const lines: string[] = [];
    const info = spyOn(log, "info").mockImplementation(line => { lines.push(line); });
    markRunning(SPACE, BOB, "original");
    try {
      const registration = memberRegistration({ definition: { name: "probe", description: "probe", parameters: {} } as never,
        replay: "safe", outputLimits: {} as never, async run() {
          markRunning(SPACE, BOB, "next");
          await timedCommand(async () => ({ exitCode: 0 }));
          return { content: [{ type: "text", text: "ok" }], details: undefined };
        } });
      const api = { taskId: 9, callId: "call", conversationId: 1, output() {}, snapshot: async () => ({ phone: BOB, space: `group:${GROUP}` }) };
      await registration.execute({}, api as never, context as never);
      await Bun.sleep(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("任务: original");
    } finally { clearRunning(SPACE, BOB, "original"); clearRunning(SPACE, BOB, "next"); info.mockRestore(); }
  });

  test("timing: an adapted tool's commands are logged with the caller from the conversation identity; no run known gives 任务: -", async () => {
    const lines: string[] = [];
    const info = spyOn(log, "info").mockImplementation(line => { if (line.startsWith("命令耗时")) lines.push(line); });
    try {
      const registration = memberRegistration({ definition: { name: "probe", description: "probe", parameters: {} } as never,
        replay: "safe", outputLimits: {} as never, async run() {
          await runProcess({ command: process.execPath, args: ["-e", "1"], cwd: process.cwd(), timeoutMs: 30000 });
          return { content: [{ type: "text", text: "ok" }], details: undefined };
        } });
      const api = { taskId: 9, callId: "call", conversationId: 1, output() {},
        snapshot: async () => ({ phone: BOB, space: `group:${GROUP}` }) };
      const result = await registration.execute({}, api as never, context as never);
      expect(result.isError).toBeUndefined();
      const deadline = Date.now() + 5000;
      while (!lines.length && Date.now() < deadline) await Bun.sleep(10);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.startsWith(`命令耗时 - 群 ${GROUP}, 用户: ${BOB}, 任务: -, 工具: probe#9, 结果: 退出码 0, 总: `)).toBe(true);
    } finally { info.mockRestore(); }
  }, 30_000);

  test("bash cancel: the aborted result keeps the output's tail, the shell and its child stop, the full output moves into the caller's tmp", async () => {
    const group = await openGroup();
    try {
      const conversation = await member(group, ALICE);
      const places = memberPlaces(group.tools, SPACE, ALICE);
      const command = [
        `awk 'BEGIN { for (i = 0; i < 8000; i++) print "line-" i }'`,
        // Git Bash's $$ and $! are MSYS pids; /proc/<pid>/winpid gives the Windows one.
        'pid() { if [ -r "/proc/$1/winpid" ]; then cat "/proc/$1/winpid"; else echo "$1"; fi; }',
        'pid $$ > "$PI_USER_TMP/shell.pid"',
        'sleep 30 & pid $! > "$PI_USER_TMP/sleep.pid"',
        "echo ready",
        "wait",
        'echo late > "$PI_USER_TMP/late.txt"',
      ].join("\n");
      const t = await turn(group, conversation, [fauxToolCall("bash", { command }, { id: "cancel" })], async () => {
        await until(async () => (await group.opened.harness.snapshot(LiveDoc, conversation.id, context))?.tools
          ?.some((slot) => slot.status === "running" && (slot.output ?? "").includes("ready")) ?? false, "ready published", 30_000);
        await conversation.abort(context);
      });
      expect(t.settled).toMatchObject({ reason: "aborted" });
      expect(t.outcomes.cancel).toBe("aborted");
      const result = t.results.cancel!;
      expect(result.isError).toBe(true);
      expect(result.text).toContain("line-7999\nready");
      expect(result.text).not.toContain("line-0\n");
      expect(result.text).toContain("Tool bash was aborted");
      for (const name of ["shell.pid", "sleep.pid"]) {
        const pid = Number((await readFile(join(places.tempDir, name), "utf8")).trim());
        expect(pid).toBeGreaterThan(0);
        await until(() => !alive(pid), `${name} ${pid} gone`);
      }
      const logs = async () => (await readdir(places.tempDir)).filter((name) => name.startsWith("pi-bash-") && name.endsWith(".log"));
      await until(async () => (await logs()).length === 1, "full output moved");
      const full = await readFile(join(places.tempDir, (await logs())[0]!), "utf8");
      expect(full.startsWith("line-0\n") && full.includes("ready")).toBe(true);
      expect(existsSync(join(places.tempDir, "late.txt"))).toBe(false);
    } finally { await group.close(); }
  }, 60_000);

  test("bash output keeps a U+FEFF that is text (pi-durable 1.0.4): only a byte-order mark at the very start is dropped", async () => {
    const group = await openGroup();
    try {
      const conversation = await member(group, ALICE);
      /** The running output once "ready" is published; then the call is aborted. Its aborted result. */
      const running = async (id: string, command: string) => {
        let output = "";
        const t = await turn(group, conversation, [fauxToolCall("bash", { command }, { id })], async () => {
          await until(async () => {
            const slot = (await group.opened.harness.snapshot(LiveDoc, conversation.id, context))?.tools
              ?.find((each) => each.status === "running" && (each.output ?? "").endsWith("ready\n"));
            output = slot?.output ?? "";
            return slot !== undefined;
          }, "ready published", 30_000);
          await conversation.abort(context);
        });
        expect(t.outcomes[id]).toBe("aborted");
        return { output, result: t.results[id]! };
      };
      // A mark at the start, then one split across two chunks.
      const split = await running("split", String.raw`printf '\357\273\277开头\n'; sleep 0.3; printf 'a\n\357\273'; sleep 0.3; printf '\277b\n'; echo ready; sleep 30`);
      expect(split.output).toBe("开头\na\n\ufeffb\nready\n");
      expect(split.result.text).toStartWith("开头\na\n\ufeffb\nready\n");
      // The tail window (2200 lines) starts at a line that begins with U+FEFF.
      const tail = await running("tail", String.raw`awk 'BEGIN { for (i = 0; i < 3000; i++) { if (i == 801) printf "\357\273\277"; print "line-" i } }'; echo ready; sleep 30`);
      expect(tail.output).toStartWith("\ufeffline-801\nline-802\n");
      expect(tail.result.text).toStartWith("\ufeffline-801\nline-802\n");
      expect(tail.result.text).not.toContain("line-800\n");
    } finally { await group.close(); }
  }, 90_000);

  test("bash progress: running output is committed at most every outputIntervalMs; the project's 20 ms commits more often than Durable's 100 ms and gives the same result", async () => {
    // Use the supported runtime; production images need no test-only Perl dependency.
    const executable = "'" + posix(process.execPath).replaceAll("'", "'\\''") + "'";
    const command = `${executable} -e 'for(let i=1;i<=40;i++){console.log("line-"+i);await Bun.sleep(50)}'`;
    /** Commits of a bash call that prints 40 lines over about 2 s, beyond those of one that prints once; its result. */
    const measure = async (progress: ProgressPolicy) => {
      let commits = 0;
      const counting = (storage: Storage): Storage => new Proxy(storage, {
        get: (target, property) => {
          if (property === "commit") return (...args: Parameters<Storage["commit"]>) => { commits++; return target.commit(...args); };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const group = await openGroup({ progress, storage: counting });
      try {
        const conversation = await member(group, ALICE);
        let before = commits;
        await turn(group, conversation, [fauxToolCall("bash", { command: "echo once" }, { id: "once" })]);
        const once = commits - before;
        before = commits;
        const started = Date.now();
        const t = await turn(group, conversation, [fauxToolCall("bash", { command }, { id: "stream" })]);
        return { extra: commits - before - once, ms: Date.now() - started, text: t.results.stream!.text };
      } finally { await group.close(); }
    };
    const project = await measure(PROGRESS);
    const control = await measure(DEFAULT_PROGRESS_POLICY);
    for (const [name, policy, measured] of [["project", PROGRESS, project], ["Durable default", DEFAULT_PROGRESS_POLICY, control]] as const) {
      console.log(`bash progress, ${name} outputIntervalMs=${policy.outputIntervalMs}: ${measured.extra} more commits over ${measured.ms} ms than a one-line bash`);
      expect(measured.extra).toBeLessThanOrEqual(Math.ceil(measured.ms / policy.outputIntervalMs) + 5);
    }
    expect(project.extra).toBeGreaterThan(control.extra);
    expect(project.text).toBe(control.text);
    expect(project.text).toContain("line-1\n");
    expect(project.text).toContain("line-40");
  }, 60_000);

  test("recovery: closing the Harness stops a running bash; reopened, the call is reported interrupted and not run again", async () => {
    const group = await openGroup();
    let reopened: GroupHarness | undefined;
    try {
      const conversation = await member(group, ALICE);
      const places = memberPlaces(group.tools, SPACE, ALICE);
      const command = [
        'pid() { if [ -r "/proc/$1/winpid" ]; then cat "/proc/$1/winpid"; else echo "$1"; fi; }',
        'echo run >> "$PI_USER_TMP/runs.txt"',
        'pid $$ > "$PI_USER_TMP/shell.pid"',
        'sleep 30 & pid $! > "$PI_USER_TMP/sleep.pid"',
        "echo ready",
        "wait",
      ].join("\n");
      group.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "recover" })], { stopReason: "toolUse" })]);
      await conversation.submit({ type: "input", content: "处理一下" }, context);
      await until(async () => (await group.opened.harness.snapshot(LiveDoc, conversation.id, context))?.tools
        ?.some((slot) => slot.status === "running" && (slot.output ?? "").includes("ready")) ?? false, "ready published", 30_000);
      await group.close();
      for (const name of ["shell.pid", "sleep.pid"]) {
        const pid = Number((await readFile(join(places.tempDir, name), "utf8")).trim());
        await until(() => !alive(pid), `${name} ${pid} gone`);
      }

      group.faux.setResponses([fauxAssistantMessage("好的")]);
      reopened = await openGroupHarness(group.opened.path, group.models, { scope: SPACE, extensions: [baseExtension(group.tools)] });
      const again = (await reopened.harness.conversation(conversation.id, context))!;
      await again.waitForIdle(context);
      const result = (await again.entries({}, 1000, undefined, context)).items
        .map((entry) => entry.model?.[0] as { toolCallId?: string; isError?: boolean; content: Content[] } | undefined)
        .find((message) => message?.toolCallId === "recover");
      expect(result?.isError).toBe(true);
      expect(result!.content.map((item) => item.text ?? "").join("")).toContain("Tool bash was interrupted and may have partially run");
      expect(await readFile(join(places.tempDir, "runs.txt"), "utf8")).toBe("run\n");
    } finally {
      await reopened?.close();
      await group.close().catch(() => {});
    }
  }, 60_000);

  test("edit and write: a mismatch is an error result and every tool task completes", async () => {
    const group = await openGroup();
    try {
      const places = memberPlaces(group.tools, SPACE, ALICE);
      await mkdir(places.tempDir, { recursive: true });
      const draft = join(places.tempDir, "草稿.txt");
      await writeFile(draft, "客户A的方案\n第二行\n");
      const t = await turn(group, await member(group, ALICE), [
        fauxToolCall("edit", { path: draft, edits: [{ oldText: "客户A", newText: "客户B" }] }, { id: "edit" }),
        fauxToolCall("edit", { path: draft, edits: [{ oldText: "不存在的文字", newText: "x" }] }, { id: "edit_miss" }),
        fauxToolCall("write", { path: join(places.tempDir, "新文件.txt"), content: "新内容\n" }, { id: "write" }),
      ]);
      expect(Object.fromEntries(Object.entries(t.results).map(([id, result]) => [id, result.isError]))).toEqual({ edit: false, edit_miss: true, write: false });
      expect(await readFile(draft, "utf8")).toBe("客户B的方案\n第二行\n");
      expect(await readFile(join(places.tempDir, "新文件.txt"), "utf8")).toBe("新内容\n");
      expect(new Set(Object.values(t.outcomes))).toEqual(new Set(["completed", "failed"]));
    } finally { await group.close(); }
  });

  test("arguments: edit's legacy single replacement is repaired before validation; a call missing a required argument runs nothing", async () => {
    const group = await openGroup();
    try {
      const places = memberPlaces(group.tools, SPACE, ALICE);
      await mkdir(places.tempDir, { recursive: true });
      const draft = join(places.tempDir, "旧格式.txt");
      await writeFile(draft, "甲乙丙\n");
      const t = await turn(group, await member(group, ALICE), [
        fauxToolCall("edit", { path: draft, oldText: "乙", newText: "丁" }, { id: "legacy" }),
        fauxToolCall("write", { content: "没有路径" }, { id: "missing" }),
      ]);
      expect(t.results.legacy).toMatchObject({ isError: false });
      expect(await readFile(draft, "utf8")).toBe("甲丁丙\n");
      expect(t.results.missing).toMatchObject({ isError: true });
      expect(t.results.missing!.text).toContain("<harness>");
      expect(await readdir(places.tempDir)).toEqual(["旧格式.txt"]);
    } finally { await group.close(); }
  });

  // Unix permission bits; Windows has none of these and root bypasses them.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("permissions: an unreadable file and a read-only directory in the caller's tmp give error results", async () => {
    const group = await openGroup();
    const places = memberPlaces(group.tools, SPACE, ALICE);
    const locked = join(places.tempDir, "锁定.txt");
    const sealed = join(places.tempDir, "只读目录");
    try {
      await mkdir(sealed, { recursive: true });
      await writeFile(locked, "秘密");
      await chmod(locked, 0o000);
      await chmod(sealed, 0o500);
      const t = await turn(group, await member(group, ALICE), [
        fauxToolCall("read", { path: locked }, { id: "unreadable" }),
        fauxToolCall("write", { path: join(sealed, "新.txt"), content: "x" }, { id: "sealed" }),
      ]);
      expect(t.results.unreadable).toMatchObject({ isError: true });
      expect(t.results.sealed).toMatchObject({ isError: true });
      expect(existsSync(join(sealed, "新.txt"))).toBe(false);
      expect(new Set(Object.values(t.outcomes))).toEqual(new Set(["failed"]));
    } finally {
      await chmod(locked, 0o600).catch(() => {});
      await chmod(sealed, 0o700).catch(() => {});
      await group.close();
    }
  });
});
