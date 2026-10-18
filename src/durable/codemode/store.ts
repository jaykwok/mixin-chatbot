import type { JsonValue } from "@earendil-works/chord";
import { MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS } from "@earendil-works/pi-codemode";

/** The sandbox's store limits (pi-codemode `store()`), on the whole store. Throws why the store does not fit. */
export function checkStoreLimits(values: Readonly<Record<string, JsonValue>>): void {
  let total = 0;
  for (const [key, value] of Object.entries(values)) {
    const json = JSON.stringify(value);
    if (json.length > MAX_STORE_VALUE_CHARS) {
      throw new RangeError(`store(${JSON.stringify(key)}) value has ${json.length} characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}`);
    }
    total += key.length + json.length;
  }
  if (total > MAX_STORE_TOTAL_CHARS) {
    throw new RangeError(`store is full: with the writes of other scripts, stored values would have ${total} characters of JSON, more than the limit of ${MAX_STORE_TOTAL_CHARS}. Delete keys with store(key, undefined).`);
  }
}
