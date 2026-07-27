import { describe, expect, test } from "bun:test";
import { observeCallbackRoute } from "../../src/integrations/callback-route.ts";

describe("callback key group routing", () => {
  test("fails closed when one callback key appears in multiple groups", () => {
    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=route-${crypto.randomUUID()}`;

    const first = observeCallbackRoute(callbackUrl, "group-a");
    expect(first.safe).toBe(true);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(observeCallbackRoute(callbackUrl, "group-a").safe).toBe(true);

    const conflict = observeCallbackRoute(callbackUrl, "group-b");
    expect(conflict.safe).toBe(false);
    expect(conflict.groups).toEqual(["group-a", "group-b"]);
    expect(observeCallbackRoute(callbackUrl, "group-a").safe).toBe(false);
  });

  test("accepts distinct callback keys for distinct groups", () => {
    const suffix = crypto.randomUUID();
    const callbackA =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=a-${suffix}`;
    const callbackB =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=b-${suffix}`;

    expect(observeCallbackRoute(callbackA, "group-a").safe).toBe(true);
    expect(observeCallbackRoute(callbackB, "group-b").safe).toBe(true);
  });
});
