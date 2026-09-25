import { parseArgs, type ParseArgsConfig } from "node:util";

/** All administrative options are single-valued; never silently take the last one. */
export function cliArgs<const T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T) {
  const parsed = parseArgs({ args, options, strict: true, allowPositionals: true, tokens: true });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`参数不能重复：--${token.name}`);
    if (token.value === "") throw new Error(`--${token.name} 缺少值`);
    seen.add(token.name);
  }
  return parsed;
}

export const groupOptions = { "group-id": { type: "boolean" }, "storage-segment": { type: "boolean" } } as const;
export function groupSelection(values: { "group-id"?: boolean; "storage-segment"?: boolean }, group?: string): "auto" | "id" | "segment" {
  if (values["group-id"] && values["storage-segment"]) throw new Error("群目录选择参数不能重复或同时使用");
  if ((values["group-id"] || values["storage-segment"]) && !group) throw new Error("群目录选择参数需要同时指定群");
  return values["group-id"] ? "id" : values["storage-segment"] ? "segment" : "auto";
}
