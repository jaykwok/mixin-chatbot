// Function definitions cut out of scripts/ops.sh for the wrapper tests, which stub everything around them. A
// definition starts at "<name>() (" or "<name>() {" at the start of a line and ends at the first ")" or "}" alone on a
// line: nested definitions are indented.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OPS = fileURLToPath(new URL("../../scripts/ops.sh", import.meta.url));

export async function opsShellFunctions(...names: string[]): Promise<string> {
  const source = "\n" + (await readFile(OPS, "utf8")).replaceAll("\r\n", "\n");
  return names.map(name => {
    for (const [open, close] of [["() (\n", "\n)\n"], ["() {\n", "\n}\n"]] as const) {
      const from = source.indexOf("\n" + name + open);
      if (from < 0) continue;
      const until = source.indexOf(close, from + 1);
      if (until > from) return source.slice(from + 1, until + close.length);
    }
    throw new Error("ops.sh has no function " + name);
  }).join("\n");
}
