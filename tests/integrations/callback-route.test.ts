import { describe, expect, test } from "bun:test";
import { CALLBACK_ROUTE_TTL } from "../../src/core/config.ts";
import {
  callbackDeliverySignal,
  cleanupCallbackRoutes,
  forgetCallbackRoute,
  listCallbackRoutes,
  observeCallbackRoute,
  resetCallbackRoute,
} from "../../src/integrations/callback-route.ts";
import { sendText } from "../../src/integrations/im.ts";
import { openState } from "../../src/core/state.ts";
import { STATE_DATABASE_PATH } from "../../src/core/storage.ts";

test("a discovered conflict cancels both in-flight and queued delivery", async () => {
  const callback = `https://im.zdxlz.com/im-external/v1/webhook/send?key=inflight-${crypto.randomUUID()}`;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++; started();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const first = sendText("first", "first-group", "user", callback).catch(error => error);
    await ready;
    const second = sendText("second", "first-group", "user", callback).catch(error => error);
    observeCallbackRoute(callback, "other-group");
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    expect(calls).toBe(1);
    for (let i = 0; i < 10; i++) expect(observeCallbackRoute(callback, "extra-" + i).groups).toEqual(["first-group", "other-group"]);
    const database = openState(STATE_DATABASE_PATH);
    try {
      const row = database.query("SELECT group_id, conflict FROM callback_routes WHERE group_id = ?").get("first-group");
      expect(row).toEqual({ group_id: "first-group", conflict: "other-group" });
    } finally { database.close(); }
    expect(callbackDeliverySignal(callback).aborted).toBe(true);
  } finally { globalThis.fetch = original; }
});

describe("callback key group routing", () => {
  test("an explicit rebind clears a quarantine without reviving any old delivery signal", () => {
    const callback = `https://im.zdxlz.com/im-external/v1/webhook/send?key=rebind-${crypto.randomUUID()}`;
    const first = observeCallbackRoute(callback, "original-group");
    const oldSignal = callbackDeliverySignal(callback);
    observeCallbackRoute(callback, "conflicting-group");
    cleanupCallbackRoutes(Date.now() + CALLBACK_ROUTE_TTL + 1);
    expect(observeCallbackRoute(callback, "original-group").safe).toBe(false);
    const reset = resetCallbackRoute(first.fingerprint, "intended-group");
    expect(reset).toMatchObject({ groupId: "intended-group", conflictingGroupId: null });
    expect(reset.fingerprint).toHaveLength(64);
    expect(listCallbackRoutes().find(row => row.fingerprint === reset.fingerprint)).toEqual(reset);
    const current = callbackDeliverySignal(callback, "intended-group");
    expect(current.aborted).toBe(false);
    expect(oldSignal.aborted).toBe(true);
    expect(observeCallbackRoute(callback, "conflicting-group").safe).toBe(false);
    expect(current.aborted).toBe(true);
  });

  test("forgetting a retired binding cancels its holders and requires a fresh binding", () => {
    const callback = `https://im.zdxlz.com/im-external/v1/webhook/send?key=forget-${crypto.randomUUID()}`;
    const first = observeCallbackRoute(callback, "old-group");
    const signal = callbackDeliverySignal(callback);
    const count = listCallbackRoutes().length;
    forgetCallbackRoute(first.fingerprint);
    expect(listCallbackRoutes()).toHaveLength(count - 1);
    expect(signal.aborted).toBe(true);
    expect(() => callbackDeliverySignal(callback)).toThrow("尚未绑定");
    expect(observeCallbackRoute(callback, "new-group").safe).toBe(true);
    expect(() => resetCallbackRoute(first.fingerprint, "\ninvalid")).toThrow("目标群号");
  });

  test("an unbound key cannot allocate an outbound route", () => {
    expect(() => callbackDeliverySignal(`https://im.zdxlz.com/im-external/v1/webhook/send?key=unbound-${crypto.randomUUID()}`)).toThrow("尚未绑定");
  });
  test("fails closed when one callback key appears in multiple groups", () => {
    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=route-${crypto.randomUUID()}`;

    const first = observeCallbackRoute(callbackUrl, "group-a");
    expect(first.safe).toBe(true);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(observeCallbackRoute(callbackUrl, "group-a").safe).toBe(true);

    const conflict = observeCallbackRoute(callbackUrl, "group-b");
    expect(conflict.safe).toBe(false);
    expect(conflict.reason).toBe("conflict");
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

  test("reclaims route observations after their idle TTL", () => {
    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=stale-${crypto.randomUUID()}`;
    expect(observeCallbackRoute(callbackUrl, "group-a").safe).toBe(true);

    cleanupCallbackRoutes(Date.now() + CALLBACK_ROUTE_TTL + 1);

    expect(observeCallbackRoute(callbackUrl, "group-b")).toMatchObject({
      safe: true,
      reason: "ok",
      groups: ["group-b"],
    });
  });
});
