import { expect, test } from "bun:test";
import { ReferenceText } from "../../src/core/reference-text.ts";

// Lookups must answer exactly like a substring search of the whole text, for both separators.
for (const separator of ["/", "\\"]) test(`reference lookups equal substring search (separator ${JSON.stringify(separator)})`, () => {
  let seed = 7;
  const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const join = (...parts: string[]) => parts.join(separator);
  const members = ["u1", "u10", "u2"].map(user => join("", "groups", "g", "users", user, "tmp"));
  const names = ["1-call", "1-call2", "12-call", "2-x", "3-a.b_c", "x".repeat(600)];
  const directories = members.flatMap(member => [join(member, "codemode") + separator, join(member, ".isolated-work") + separator]);
  const pieces = [...directories.flatMap(directory => names.map(name => directory + name)), "noise", " ", "\n", separator, "codemode", ...names];
  for (let round = 0; round < 40; round++) {
    const text = Array.from({ length: random(30) }, () => pieces[random(pieces.length)]).join("");
    let calls = 0;
    const references = new ReferenceText(() => { calls++; return text; }, separator);
    for (const directory of directories) for (const name of [...names, "", "1", "1-call2x", "zzz"]) {
      expect(references.includes(directory + name, directory)).toBe(text.includes(directory + name));
    }
    // A path outside the given directory still gets the plain answer.
    expect(references.includes("noise", directories[0]!)).toBe(text.includes("noise"));
    expect(calls).toBe(1);
  }
});

test("reference text is not built when nothing is looked up", () => {
  let built = false;
  new ReferenceText(() => { built = true; return ""; }, "/");
  expect(built).toBe(false);
});
