/**
 * 声明了 structuredOutputSchema 的工具的成功结果。模型看到的文本、脚本拿到的 structuredOutput 和写进历史的
 * details 是同一份数据，直接调用和脚本调用得到的内容一致。失败一律抛错：带 structuredOutput 的
 * 错误结果在脚本里会正常返回，脚本不检查就会把失败当成功继续用。
 * data 必须是 JSON 数据且符合工具的 structuredOutputSchema；测试按 schema 严格校验。
 */
export function structuredResult<T extends object>(data: T) {
  return { output: [{ type: "text" as const, text: JSON.stringify(data) }], structuredOutput: data, details: data };
}
