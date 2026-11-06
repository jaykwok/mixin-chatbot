// Structured identity by mode. The console host decides here what the page may see — masked, complete or no number,
// name or none — before anything is sent: the page never receives more than its mode allows and never masks anything
// itself. Message text, tool output and file names are not touched (the page and exports say so).
import { randomInt } from "node:crypto";
import type { Identity, IdentityMode, NamesStatus, NameState } from "../ui/src/contract.ts";
import { READ_LIMITS } from "../../src/durable/read/protocol.ts";
import { maskUser } from "../../ops/lib/format.ts";
import { BotOffline, type BotReader } from "./bot.ts";

/** Ledger identities of some old imports are digests (`sha256-user-…`): there is no number to show or look up. */
export const isSummaryIdentity = (user: string) => user.startsWith("sha256-user-");

export const NAME_NOTES: Record<Exclude<NameState, "named">, string> = {
  missing: "当前通讯录缓存未找到",
  summary: "只有摘要形式身份",
  offline: "机器人未运行，姓名不可用",
  failed: "姓名查询失败或暂不可用",
};

export const MODE_LABELS: Record<IdentityMode, string> = { default: "默认（姓名＋打码号码）", full: "完整身份", anonymous: "匿名" };

/** What the page and exports say about the reach of a mode. */
export const IDENTITY_SCOPE_NOTE = "身份模式只作用于成员号码、姓名和成员标识等结构化字段；聊天正文、工具输出、附件文件名和日志原文按原样保留，其中出现的姓名或号码不会被替换。";

export interface NameInfo { state: NameState; name?: string; observedAt?: number }

/** Opaque per-view identifiers: random, never derived from the number. */
export const opaqueKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString("base64url");

/**
 * Names of `users` from the bot's directory cache, in batches. Every user gets a state; a failed or impossible lookup marks
 * its members and never throws (the caller's statistics or conversation still answer). Only cancellation propagates.
 */
export async function lookupNames(bot: BotReader, users: Iterable<string>, signal?: AbortSignal): Promise<{ names: Map<string, NameInfo>; status: NamesStatus }> {
  const names = new Map<string, NameInfo>();
  const phones: string[] = [];
  for (const user of new Set(users)) {
    if (isSummaryIdentity(user)) names.set(user, { state: "summary" });
    else phones.push(user);
  }
  let offline: string | undefined, error: string | undefined;
  for (let start = 0; start < phones.length; start += READ_LIMITS.names) {
    const batch = phones.slice(start, start + READ_LIMITS.names);
    if (offline !== undefined) { for (const phone of batch) names.set(phone, { state: "offline" }); continue; }
    try {
      const result = await bot.read<{ found: { phone: string; name: string }[]; observedAt: number }>({ op: "names", phones: batch }, signal);
      const found = new Map(result.found.map(row => [row.phone, row.name.trim()]));
      for (const phone of batch) {
        const name = found.get(phone);
        names.set(phone, name ? { state: "named", name, observedAt: result.observedAt } : { state: "missing", observedAt: result.observedAt });
      }
    } catch (reason) {
      signal?.throwIfAborted();
      if (reason instanceof BotOffline) {
        offline = reason.message;
        for (const phone of batch) names.set(phone, { state: "offline" });
      } else {
        error ??= redactPhones((reason as Error).message, batch);
        for (const phone of batch) names.set(phone, { state: "failed" });
      }
    }
  }
  return { names, status: namesStatus([...names.values()], error ?? offline) };
}

/** The overall lookup state of a set of members; `note` explains a failure. Digest identities are not lookups. */
export function namesStatus(infos: readonly NameInfo[], note?: string): NamesStatus {
  let answered = 0, offline = 0, failed = 0, observedAt: number | undefined;
  for (const info of infos) {
    if (info.state === "named" || info.state === "missing") {
      answered++;
      if (info.observedAt !== undefined) observedAt = Math.min(observedAt ?? Infinity, info.observedAt);
    } else if (info.state === "offline") offline++;
    else if (info.state === "failed") failed++;
  }
  const status: NamesStatus = !offline && !failed ? { state: "ok" }
    : !answered && !failed ? { state: "offline" }
    : !answered ? { state: "failed" }
    : { state: "partial" };
  if (status.state !== "ok" && note !== undefined) status.note = note;
  // The oldest reading: every name shown was read at this time or later.
  if (observedAt !== undefined) status.observedAt = observedAt;
  return status;
}

// Letters without I and O, so a code is never read as a digit.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/** In-view or in-export member codes (A3, K17…): random, unique within their set, never derived from the number. */
export class MemberCodes {
  readonly #used = new Set<string>();

  next(): string {
    // Grow the number range so at most a quarter of the codes are taken: a free one is found in a few tries.
    let digits = 1;
    while (LETTERS.length * (10 ** digits - 1) < 4 * (this.#used.size + 1)) digits++;
    for (;;) {
      const code = LETTERS[randomInt(LETTERS.length)]! + (1 + randomInt(10 ** digits - 1));
      if (!this.#used.has(code)) { this.#used.add(code); return code; }
    }
  }
}

/** The identity of `user` as `mode` allows it; `code` is required in anonymous mode. */
export function identityOf(mode: IdentityMode, key: string, user: string, name: NameInfo | undefined, code?: string): Identity {
  if (mode === "anonymous") return { key, label: `成员 ${code ?? "?"}` };
  const phone = mode === "full" ? user : maskUser(user);
  const info: NameInfo = isSummaryIdentity(user) ? { state: "summary" } : name ?? { state: "failed" };
  const identity: Identity = { key, label: info.state === "named" ? `${info.name}（${phone}）` : phone, phone, nameState: info.state };
  if (info.state === "named") identity.name = info.name!;
  else identity.nameNote = NAME_NOTES[info.state];
  if (info.observedAt !== undefined) identity.nameObservedAt = info.observedAt;
  return identity;
}

/** Replaces each of `phones` in `text` (structured text such as error messages, not message bodies). */
export function redactPhones(text: string, phones: Iterable<string>, replace: (phone: string) => string = maskUser): string {
  let out = text;
  for (const phone of phones) if (phone.length >= 5 && out.includes(phone)) out = out.replaceAll(phone, replace(phone));
  return out;
}
