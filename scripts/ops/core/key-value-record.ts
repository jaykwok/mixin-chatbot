// Line-oriented key=value records of a deployment snapshot or stage (candidate image, service identity, tool paths, ...):
// every key exactly once, nothing unknown, each value matching its pattern.
export type Values<K extends string> = Record<K, string>;

export function parseRecord<K extends string>(text: string, keys: readonly K[], patterns: Record<K, RegExp>, label: string): Values<K> {
  const values = {} as Values<K>;
  for (const line of (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n")) {
    const at = line.indexOf("="), key = line.slice(0, at) as K, value = line.slice(at + 1);
    if (at < 0 || !keys.includes(key) || Object.hasOwn(values, key) || !patterns[key].test(value)) throw new Error(`${label}无效：${at < 0 ? "格式" : line.slice(0, at)}`);
    values[key] = value;
  }
  if (keys.some(key => !Object.hasOwn(values, key))) throw new Error(`${label}不完整`);
  return values;
}
export const serializeRecord = <K extends string>(record: Values<K>, keys: readonly K[]) => keys.map(key => `${key}=${record[key]}`).join("\n") + "\n";
