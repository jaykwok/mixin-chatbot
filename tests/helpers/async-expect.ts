// Bun 1.4.2's promise matchers spin their own wait loop, which does not deliver node Worker messages.
// Await the value in ordinary JS first, then run the unchanged Bun matcher on an already settled promise.
// Assertion semantics/counts and failures stay Bun's; no production polling or timeout relaxation is needed.
import { expect } from "bun:test";

export const expectAsync: typeof expect = new Proxy(expect, {
  apply(target, receiver, args) {
    const assertion = Reflect.apply(target, receiver, args);
    const value = args[0];
    if (value === null || value === undefined || typeof value.then !== "function") return assertion;
    const chain = (kind: "resolves" | "rejects", negate = false): object => new Proxy({}, {
      get(_target, key) {
        if (key === "not") return chain(kind, !negate);
        return async (...params: unknown[]) => {
          const result = await Promise.resolve(value).then(
            (value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
          const settled = result.ok ? Promise.resolve(result.value) : Promise.reject(result.error);
          const native = expect(settled)[kind];
          const matcher = negate ? native.not : native;
          return Reflect.apply(Reflect.get(matcher, key), matcher, params);
        };
      },
    });
    return new Proxy(assertion, { get(target, key, receiver) {
      return key === "resolves" || key === "rejects" ? chain(key) : Reflect.get(target, key, receiver);
    } });
  },
});
