import { cliArgs } from "./cli.ts";
export const RELAY_OPTIONS = { all: { type: "boolean" }, keyword: { type: "string" }, expect: { type: "string" } } as const;
/** --keyword explicitly makes the following string literal, including --all or a leading dash. */
export function relayLiteralArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    result.push(arg === "--keyword" && i + 1 < args.length ? "--keyword=" + args[++i] : arg);
  }
  return result;
}
export function relayOptions(args: string[]) {
  const { values, positionals } = cliArgs(relayLiteralArgs(args), RELAY_OPTIONS);
  const [raw = "help", argument, ...extra] = positionals, command = raw === "ls" ? "list" : raw;
  if (!["list", "test", "purge", "help"].includes(command) || extra.length) throw new Error("外链动作或参数无效");
  if (values.expect !== undefined && (!/^[a-f0-9]{64}$/.test(values.expect) || !["test", "purge"].includes(command))) throw new Error("--expect 只接受测试或清理外链的 SHA-256 摘要");
  const keyword = values.keyword ?? argument;
  if (command === "purge") {
    if (values.keyword !== undefined && argument !== undefined || values.all && keyword !== undefined || !values.all && !keyword)
      throw new Error("清理外链需要 --all 或一个关键字，不能同时选择");
    if (keyword !== undefined && (!keyword.trim() || keyword.length > 4096 || /[\x00-\x1f\x7f]/.test(keyword))) throw new Error("外链关键字无效");
  } else if (argument !== undefined || values.keyword !== undefined || values.all !== undefined) throw new Error(`${command} 不接受清理范围`);
  const normalized = [command, ...(command === "purge" ? values.all ? ["--all"] : ["--keyword", keyword!] : []), ...(values.expect ? ["--expect", values.expect] : [])];
  return { command, keyword, expected: values.expect, normalized };
}
