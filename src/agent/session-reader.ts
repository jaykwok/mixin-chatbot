// 会话文件的增量只读扫描：把 session.jsonl 的新增行投影成统计用的最小记录。
// 游标由调用方持久化（见 stats-ledger.ts），本模块不保留任何进程内状态。
import { createHash } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { isSlashCommandMessage } from "./commands.ts";

export interface StatsRecord {
  type?: string; timestamp?: string; provider?: string; modelId?: string; model?: string; kind?: string; usage?: Record<string, unknown>;
  message?: { role?: string; command?: boolean; provider?: string; model?: string; content?: { type: string; name?: string }[];
    usage?: Record<string, unknown>; toolName?: string; isError?: boolean; details?: { fileId?: string } };
}

/** 已入账前缀的位置与摘要；摘要只覆盖真正入账过的字节。 */
export interface SessionCursor {
  identity: string;
  offset: number;
  digest: string;
}

/** 读取期间身份或内容改变：调用方须重新取得账本游标后再读，不能提交混合快照。 */
export class SessionFileChangedError extends Error {
  constructor() { super("会话文件在读取期间发生变化，请重新入账"); }
}

export interface SessionSlice {
  /** 会话头里的 id，只在整份重读时取得；用作账本里这一世代的主键。 */
  sessionId?: string;
  /** 本次新增的完整行；重读时是整份文件。 */
  records: StatsRecord[];
  cursor: SessionCursor;
  /** 本次新增区段里解析失败的完整行数。 */
  badLines: number;
  /** 末尾还有没写完的半行：这次不入账，等写完再算。 */
  pending: boolean;
  /** 文件被换掉或改写过，调用方必须先清掉这一世代的旧行。 */
  reset: boolean;
}

function project(line: string): StatsRecord {
  const raw = JSON.parse(line);
  if (!raw || typeof raw !== "object") return {};
  const m = raw.message;
  const content = Array.isArray(m?.content) ? m.content : [];
  return { type: raw.type, timestamp: raw.timestamp, provider: raw.provider, modelId: raw.modelId, model: raw.model,
    kind: typeof raw.kind === "string" ? raw.kind : undefined, usage: raw.usage,
    ...(m && { message: { role: m.role, provider: m.provider, model: m.model, usage: m.usage,
      command: m.role === "user" && isSlashCommandMessage(content.find((part: any) => part?.type === "text")?.text ?? ""),
      content: content.filter((part: any) => part?.type === "toolCall" && typeof part.name === "string").map((part: any) => ({ type: "toolCall", name: part.name })),
      toolName: m.toolName, isError: m.isError, details: m.details?.fileId ? { fileId: "confirmed" } : undefined } }),
  };
}

/** 会话头的 id 是这一世代的身份：/clear 之后 Pi 会新建文件并换 id，旧账不受影响。 */
function headerSessionId(line: string): string | undefined {
  try {
    const raw = JSON.parse(line) as { type?: unknown; id?: unknown };
    return raw?.type === "session" && typeof raw.id === "string" && raw.id ? raw.id : undefined;
  } catch { return undefined; }
}

/** 显式位置读取，不重新按路径开文件；短读继续，提前 EOF 则放弃本轮。 */
async function readInto(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let filled = 0;
  while (filled < bytes.length) {
    const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, position + filled);
    if (!bytesRead) throw new SessionFileChangedError();
    filled += bytesRead;
  }
}

/**
 * 读取自 `prior` 之后新增的部分。
 *
 * 追加写入只解析新字节；整个旧前缀的摘要必须对上，原地改写后再追加不会被当成追加。
 * 摘要对不上或文件换了身份就整份重读并置 `reset`，由调用方替换这一世代的全部行——
 * 入账因此是幂等的，重跑或补跑都不会把数字算两遍。
 */
export async function readSessionSlice(path: string, prior?: SessionCursor): Promise<SessionSlice> {
  const file = resolve(path);
  const observed = await lstat(file);
  if (!observed.isFile() || observed.isSymbolicLink()) throw new Error("会话文件不是普通文件");
  const handle = await open(file, "r");
  try {
    // 后续统计与字节读取必须用同一个句柄；路径可能被 /clear 移走并换成新会话。
    const info = await handle.stat();
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    if (!info.isFile() || identity !== `${observed.dev}:${observed.ino}:${observed.birthtimeMs}`) {
      throw new SessionFileChangedError();
    }
    const hash = createHash("sha256");
    let offset = 0;
    if (prior && prior.identity === identity && prior.offset > 0 && info.size >= prior.offset) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, prior.offset));
      for (let position = 0; position < prior.offset; position += buffer.length) {
        const chunk = buffer.subarray(0, Math.min(buffer.length, prior.offset - position));
        await readInto(handle, chunk, position);
        hash.update(chunk);
      }
      if (hash.copy().digest("hex") === prior.digest) offset = prior.offset;
    }
    const reset = offset === 0;
    const bytes = Buffer.allocUnsafe(info.size - offset);
    await readInto(handle, bytes, offset);
    const after = await handle.stat();
    // 同一句柄仍可能被原地截断、改写或追加；丢弃这一轮，不能将部分读取的摘要当成新游标。
    if (after.size !== info.size
      || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new SessionFileChangedError();
    const last = bytes.lastIndexOf(10);
    const complete = bytes.subarray(0, last + 1);
    const records: StatsRecord[] = [];
    let badLines = 0, sessionId: string | undefined;
    const lines = complete.toString("utf8").split("\n");
    if (reset && lines[0]) sessionId = headerSessionId(lines[0]);
    for (const line of lines) {
      if (!line.trim()) continue;
      try { records.push(project(line)); } catch { badLines++; }
    }
    const digest = (reset ? createHash("sha256") : hash).update(complete).digest("hex");
    return { sessionId, records, badLines, reset,
      pending: bytes.subarray(last + 1).toString("utf8").trim().length > 0,
      cursor: { identity, offset: offset + complete.length, digest } };
  } finally { await handle.close(); }
}
