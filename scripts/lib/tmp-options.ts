import { resolve } from "node:path";
import { cliArgs, groupOptions, groupSelection } from "./cli.ts";

export const TMP_OPTIONS = { ...groupOptions, all: { type: "boolean" }, days: { type: "string" },
  user: { type: "string" }, group: { type: "string" }, plan: { type: "string" }, digest: { type: "string" },
  archive: { type: "string" }, journal: { type: "string" }, legacy: { type: "boolean" }, "recorded-root": { type: "string" } } as const;

/** Storage and host orchestration use the same syntax. Validation precedes any lock, plan write or service change. */
export function tmpOptions(args: string[], hosted = false) {
  const { values, positionals } = cliArgs(args, TMP_OPTIONS);
  if (positionals.length > 1) throw new Error("只能指定一个命令");
  const command = positionals[0] === "ls" ? "list" : positionals[0], selection = groupSelection(values, values.group);
  if (hosted && (values.legacy || values.journal || values["recorded-root"])) throw new Error("旧共享目录回收必须在宿主独立停机维护中执行；ops 不自动恢复该操作");
  if (values.all && values.days !== undefined) throw new Error("--all 和 --days 不能同时使用");
  const days = values.all ? 0 : values.days === undefined ? undefined : Number(values.days);
  if (days !== undefined && (!Number.isFinite(days) || days < 0)) throw new Error("--days 需要一个不小于 0 的天数");
  const confirming = values.digest !== undefined;
  if (values.plan !== undefined && !/^[a-f0-9-]{36}$/.test(values.plan)) throw new Error("归档清单 ID 无效");
  if (values.digest !== undefined && !/^[a-f0-9]{64}$/.test(values.digest)) throw new Error("清单摘要无效");
  if (command === "list") {
    if (Object.keys(values).some(k => !["user", "group", "group-id", "storage-segment"].includes(k))) throw new Error("list 只接受成员和空间范围");
  } else if (["preview", "purge", "reclaim", "discard"].includes(command ?? "")) {
    if (confirming && (!values.plan || days !== undefined || values.group || values.user)) throw new Error("执行清单只接受 --plan 和 --digest，不重新选择范围");
    if (command === "discard" && (days !== undefined || values.group || values.user)) throw new Error("discard 按已完成的归档清单处理，不接受 --days/--all/--user/--group");
    if (command !== "discard" && !confirming && days === undefined) throw new Error("预览需要 --days <天数> 或 --all；执行原清单需要 --plan 和 --digest");
    if (command === "preview" && confirming) throw new Error("preview 不执行清单");
    if (!["reclaim", "discard"].includes(command!) && (values.legacy || values.journal)) throw new Error("--legacy/--journal 只用于物理回收或删除归档");
    if (command === "reclaim" && values.archive) throw new Error("reclaim 不接受归档目录");
    if (values["recorded-root"] && !values.legacy) throw new Error("--recorded-root 只用于服务身份条目的宿主维护（--legacy）");
    if (values.legacy && (!values["recorded-root"] || !values["recorded-root"].startsWith("/") || resolve(values["recorded-root"]) !== values["recorded-root"]))
      throw new Error("服务身份条目的宿主回收必须用 --recorded-root 指定服务看到的绝对数据目录，以核对容器路径引用");
    if (values.legacy && !values.journal) throw new Error("旧共享目录回收必须指定宿主私有 --journal");
  }
  const normalized = command ? [command, ...Object.keys(values).sort().flatMap(key => {
    const value = values[key as keyof typeof values]; return value === true ? ["--" + key] : value === undefined || value === false ? [] : ["--" + key + "=" + value];
  })] : [];
  return { values, command, selection, days, confirming, mutating: confirming || command === "purge", normalized };
}
