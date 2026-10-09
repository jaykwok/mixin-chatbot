// Messages of the SQL thread. Preserve diagnostic codes and causes without sharing native handles.
import type { SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

export type SqlMethod = "exec" | "run" | "get" | "all";
export type Command = { kind: "open"; connection: number; path: string }
  | { kind: "sql"; connection: number; method: SqlMethod; sql: string; params: SqliteValue[] }
  | { kind: "close"; connection: number }
  | { kind: "stop" };
export type Request = { request: number; command: Command };
export type Reply = { request: number; ok: true; value: unknown } | { request: number; ok: false; error: RemoteError };
export type RemoteError = { name: string; message: string; stack?: string; code?: string | number; errno?: number; cause?: RemoteError };

export function encodeError(error: unknown, depth = 0): RemoteError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const extra = error as Error & { code?: string | number; errno?: number };
  return { name: error.name, message: error.message, stack: error.stack,
    ...(typeof extra.code === "string" || typeof extra.code === "number" ? { code: extra.code } : {}),
    ...(typeof extra.errno === "number" ? { errno: extra.errno } : {}),
    ...(error.cause !== undefined && depth < 5 ? { cause: encodeError(error.cause, depth + 1) } : {}) };
}

export function decodeError(error: RemoteError): Error {
  const value = new Error(error.message, error.cause === undefined ? undefined : { cause: decodeError(error.cause) });
  value.name = error.name;
  if (error.stack) value.stack = error.stack;
  if (error.code !== undefined) Object.assign(value, { code: error.code });
  if (error.errno !== undefined) Object.assign(value, { errno: error.errno });
  return value;
}
