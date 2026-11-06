import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNoBotConflict, botPorts, choosePort, DEFAULT_CONSOLE_PORT, parsePort } from "../../ops/core/console-port.ts";
import { tempFixture } from "../helpers/temp.ts";

const record = {
  format: "2", operation: "deploy", snapshot: "deploy-abc123", target_sha: "a".repeat(40), original_sha: "", original_branch: "",
  original_workspace_root: "", target_workspace_root: "", was_running: "1", bot_port: "2022", reconfigure_ai: "0",
};
const serialize = (value: Record<string, string>) => Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n") + "\n";

test("端口按 --port、保存值、默认 11012 取用，非法值直接报错", () => {
  expect(choosePort(undefined, null)).toEqual({ port: DEFAULT_CONSOLE_PORT, source: "默认值" });
  expect(choosePort(undefined, 12000)).toEqual({ port: 12000, source: "保存值" });
  expect(choosePort("13000", 12000)).toEqual({ port: 13000, source: "参数" });
  expect(parsePort(" 11012\n", "x")).toBe(11012);
  for (const bad of ["0", "65536", "080", "12a", "", "-1", "1.5"]) expect(() => choosePort(bad, null), bad).toThrow("端口无效");
});

test("保护集合包含 BOT_PORT、端口记录、未完成事务的端口；没有记录时保护部署默认值", async () => {
  const fixture = await tempFixture("console-port-");
  const root = fixture.root, state = join(root, "data", "state");
  try {
    await mkdir(state, { recursive: true });
    // No record yet: the first deployment would take 1011 (or 11011 for rootless without low ports).
    expect([...botPorts(root, {}).keys()].sort()).toEqual([1011, 11011]);

    await writeFile(join(state, "bot-port"), "1011\n");
    expect([...botPorts(root, {}).keys()]).toEqual([1011]);

    // The terminal's BOT_PORT wins over the saved value in the ops scripts, so it is protected as well.
    const withEnv = botPorts(root, { BOT_PORT: " 11012 " });
    expect(withEnv.get(11012)).toEqual(["环境变量 BOT_PORT"]);
    expect(() => assertNoBotConflict(11012, root, { BOT_PORT: "11012" })).toThrow(/控制台端口 11012 与机器人端口相同（来源：环境变量 BOT_PORT）/);
    expect(() => assertNoBotConflict(1011, root, {})).toThrow("data/state/bot-port");
    expect(() => assertNoBotConflict(11012, root, {})).not.toThrow();
    expect(() => botPorts(root, { BOT_PORT: "abc" })).toThrow("环境变量 BOT_PORT 中的端口无效");

    // A pending deploy or upgrade will start the bot on its recorded port even while it is stopped now.
    const snapshot = join(root, "backup", "snapshots", "deploy-abc123");
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(state, "deploy-transaction"), "deploy-abc123");
    await writeFile(join(snapshot, "transaction"), serialize(record));
    expect(botPorts(root, {}).get(2022)).toEqual(["未完成事务记录"]);
    expect(() => assertNoBotConflict(2022, root, {})).toThrow("未完成事务记录");

    // Unreadable records refuse instead of guessing.
    await writeFile(join(snapshot, "transaction"), "format=9\n");
    expect(() => botPorts(root, {})).toThrow("未完成的事务记录无法读取");
    await writeFile(join(state, "deploy-transaction"), "");
    await writeFile(join(state, "bot-port"), "not-a-port");
    expect(() => botPorts(root, {})).toThrow("data/state/bot-port 中的端口无效");
  } finally { await fixture.cleanup(); }
});
