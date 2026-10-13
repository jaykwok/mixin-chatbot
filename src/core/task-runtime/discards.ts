// Deletion journals of archived task trees: `discards/<id>.json` beside `receipts/` in the control root, signed with the
// manager key under its own domain, so neither kind of record can stand in for the other. The journal is saved before
// the first entry of the tree is removed and lists every entry of the reviewed tree (identity, type, file size and
// content hash, link target). An interrupted deletion resumes only while every remaining entry is one of them,
// unchanged; anything else keeps the tree. Receipts keep their format: older code never reads this directory and,
// finding the archive changed, keeps it.
//
//   (no journal) ─→ deleting ─→ removed (entries dropped; receipt then removed) ─→ forgotten once the plan saved it
import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ID_PATTERN, validTreeEvidence, type TreeEvidence } from "../../contracts/maintenance.ts";
import type { TreeEntry } from "../reclamation-files.ts";
import type { TaskControl } from "./control.ts";

export type DiscardJournal = { version: 1; id: string; destination: string; evidence: TreeEvidence; parent: { dev: string; ino: string };
  phase: "deleting" | "removed"; entries: TreeEntry[] };

const DOMAIN = "mixin-task-discard\n", MAX_BYTES = 32 * 1024 * 1024;
const digits = (value: unknown) => typeof value === "string" && /^\d+$/.test(value);
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join() === [...keys].sort().join();
const sign = (payload: string, key: Buffer) => createHmac("sha256", key).update(DOMAIN).update(payload).digest();

/** Same identity, type and (file) size and content or (link) target: the entry the journal listed, untouched. */
export function sameEntry(saved: TreeEntry, current: TreeEntry): boolean {
  return saved.path === current.path && saved.dev === current.dev && saved.ino === current.ino && saved.type === current.type
    && saved.size === current.size && saved.sha256 === current.sha256 && saved.target === current.target;
}

function validEntry(value: unknown): value is TreeEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as TreeEntry;
  const keys = entry.type === "file" ? ["path", "dev", "ino", "type", "size", "sha256"] : entry.type === "link" ? ["path", "dev", "ino", "type", "target"] : ["path", "dev", "ino", "type"];
  return exactKeys(entry, keys) && typeof entry.path === "string" && (entry.path === "" || entry.path.startsWith("/")) && digits(entry.dev) && digits(entry.ino)
    && ["directory", "file", "link"].includes(entry.type)
    && (entry.type !== "file" || Number.isSafeInteger(entry.size) && entry.size! >= 0 && /^[a-f\d]{64}$/.test(entry.sha256 ?? ""))
    && (entry.type !== "link" || typeof entry.target === "string");
}

function decode(payload: string, expected: { id: string; destination: string; evidence: TreeEvidence }): DiscardJournal {
  const value = JSON.parse(payload) as DiscardJournal;
  const fail = (field: string) => { throw new Error("任务删除日志与归档不符：" + field); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("日志");
  if (!exactKeys(value, ["version", "id", "destination", "evidence", "parent", "phase", "entries"])) fail("字段");
  if (value.version !== 1 || value.id !== expected.id || value.destination !== expected.destination) fail("version/id/destination");
  if (!validTreeEvidence(value.evidence) || JSON.stringify(value.evidence) !== JSON.stringify(expected.evidence)) fail("evidence");
  if (!value.parent || !exactKeys(value.parent, ["dev", "ino"]) || !digits(value.parent.dev) || !digits(value.parent.ino)) fail("parent");
  if (value.phase !== "deleting" && value.phase !== "removed") fail("phase");
  if (!Array.isArray(value.entries) || value.entries.length > 100_001 || !value.entries.every(validEntry)) fail("entries");
  if (new Set(value.entries.map(entry => entry.path)).size !== value.entries.length) fail("entries（路径重复）");
  const root = value.entries.find(entry => entry.path === "");
  if (value.phase === "deleting" ? root?.type !== "directory" || root.dev !== value.evidence.dev || root.ino !== value.evidence.ino : value.entries.length) fail("entries（根）");
  return value;
}

export class DiscardJournals {
  /** `publish`: the caller's atomic JSON writer (two-space indent, trailing newline), so this module stays below scripts/. */
  constructor(private readonly control: TaskControl, private readonly publish: (path: string, value: unknown) => Promise<void>) {}
  #path(id: string) { if (!ID_PATTERN.test(id)) throw new Error("任务 ID 无效"); return join(this.control.root, "discards", id + ".json"); }

  /** The saved journal for this archive, or undefined. `observe` reads beside a running service and creates nothing. */
  async load(id: string, expected: { destination: string; evidence: TreeEvidence }, observe = false): Promise<DiscardJournal | undefined> {
    const { key } = observe ? await this.control.observed() : await this.control.initialize();
    const file = await open(this.#path(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!file) return;
    let saved: { payload?: unknown; signature?: unknown };
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) || info.size > MAX_BYTES) throw new Error("任务删除日志权限或大小无效");
      saved = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
    if (!saved || typeof saved.payload !== "string" || typeof saved.signature !== "string" || !/^[a-f\d]{64}$/.test(saved.signature)
      || !timingSafeEqual(Buffer.from(saved.signature, "hex"), sign(saved.payload, key))) throw new Error("任务删除日志签名无效，保留归档");
    return decode(saved.payload, { id, ...expected });
  }

  /** Durable before the side effect it permits; a journal too large to save keeps the tree. */
  async save(journal: DiscardJournal): Promise<void> {
    const { key } = await this.control.initialize(), directory = join(this.control.root, "discards");
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077)) throw new Error("任务删除日志目录必须是管理端拥有的 0700 目录");
    const payload = JSON.stringify(journal), envelope = { payload, signature: sign(payload, key).toString("hex") };
    // The size the injected writer produces.
    if (Buffer.byteLength(JSON.stringify(envelope, null, 2)) + 1 > MAX_BYTES) throw new Error("任务删除日志过大，保留归档");
    await this.publish(this.#path(journal.id), envelope);
  }

  async drop(id: string): Promise<void> {
    await unlink(this.#path(id)).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
