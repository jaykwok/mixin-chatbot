import { expect, test } from "bun:test";
import { Auth } from "../../scripts/ops/console/auth.ts";

const limits = { exchangeMs: 5 * 60_000, idleMs: 30 * 60_000, absoluteMs: 8 * 3_600_000 };
const clock = (start = 1_000_000) => {
  const state = { now: start };
  return { state, now: () => state.now };
};

test("登录令牌只能兑换一次，过期或被新链接取代后失效", () => {
  const time = clock(), auth = new Auth(limits, time.now);
  const first = auth.issueToken();
  expect(first.expiresAt).toBe(time.state.now + limits.exchangeMs);
  const session = auth.exchange(first.token);
  expect(session?.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(session?.sessionId).not.toBe(first.token);
  expect(auth.exchange(first.token)).toBeNull();

  // A new link replaces any unused older one: only the latest printed link logs in.
  const older = auth.issueToken(), newer = auth.issueToken();
  expect(auth.exchange(older.token)).toBeNull();
  expect(auth.exchange(newer.token)).not.toBeNull();

  const late = auth.issueToken();
  time.state.now += limits.exchangeMs;
  expect(auth.exchange(late.token)).toBeNull();
  // An expired token stays consumed, it cannot be retried after the clock is wound back.
  time.state.now -= limits.exchangeMs;
  expect(auth.exchange(late.token)).toBeNull();

  for (const bad of ["", "short", "x".repeat(500), null, 42]) expect(auth.exchange(bad as string)).toBeNull();
});

test("会话闲置 30 分钟失效，只有用户操作续期，登录满 8 小时无论如何到期", () => {
  const time = clock(), auth = new Auth(limits, time.now);
  const { sessionId } = auth.exchange(auth.issueToken().token)!;
  const started = time.state.now;

  // Polls do not renew.
  time.state.now += 29 * 60_000;
  expect(auth.session(sessionId, false)?.idleExpiresAt).toBe(started + limits.idleMs);
  time.state.now += 60_000;
  expect(auth.session(sessionId, false)).toBeNull();

  const second = auth.exchange(auth.issueToken().token)!.sessionId;
  const begin = time.state.now;
  for (let step = 0; step < 8; step++) {
    time.state.now += 25 * 60_000;
    expect(auth.session(second, true)).not.toBeNull();
  }
  // Keep using it until a minute before the absolute limit, which caps the idle deadline.
  for (; time.state.now < begin + limits.absoluteMs - 60_000; time.state.now = Math.min(time.state.now + 25 * 60_000, begin + limits.absoluteMs - 60_000)) {
    expect(auth.session(second, true)).not.toBeNull();
  }
  const view = auth.session(second, true)!;
  expect(view.expiresAt).toBe(begin + limits.absoluteMs);
  expect(view.idleExpiresAt).toBe(begin + limits.absoluteMs);
  time.state.now = begin + limits.absoluteMs;
  expect(auth.session(second, true)).toBeNull();
});

test("退出撤销单个会话，控制台退出撤销全部会话和未用链接", () => {
  const auth = new Auth(limits);
  const one = auth.exchange(auth.issueToken().token)!.sessionId;
  const two = auth.exchange(auth.issueToken().token)!.sessionId;
  auth.revoke(one);
  expect(auth.session(one, false)).toBeNull();
  expect(auth.session(two, false)).not.toBeNull();
  const pending = auth.issueToken();
  auth.revokeAll();
  expect(auth.session(two, false)).toBeNull();
  expect(auth.exchange(pending.token)).toBeNull();
  expect(auth.session(undefined, true)).toBeNull();
  expect(auth.session("unknown", true)).toBeNull();
});

test("每个控制台实例使用不同的 cookie 名称", () => {
  const names = new Set(Array.from({ length: 20 }, () => new Auth(limits).cookieName));
  expect(names.size).toBe(20);
  for (const name of names) expect(name).toMatch(/^mixin_console_[A-Za-z0-9]{8}$/);
});
