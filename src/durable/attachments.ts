// Inbound attachments of direct chats (plan 5.5): registered in arrival order, downloaded in the background, bound to the
// member's next admitted request in its admission commit.
//
// - Registration (DurableService.attach) commits the receipt and a `pending` record in one commit; a registration that
//   arrives behind an admitted /stop or /clear boundary is void at once.
// - Download: `received/<id>.part` in the member's tmp (`userTmp`: `data/tmp/{direct | groups/<group>}/<member>/`), renamed
//   to `<id>-<safe name>`, then `ready` is committed only if the record is still `pending`: a late completion never
//   revives a void attachment. Left-overs of an interrupted download are removed before it starts again, so a crash
//   between rename and commit is harmless.
// - No project size limit (a product decision, not a platform guarantee): downloads stream to disk; a member holds at
//   most `memberCount` unconsumed records and at most `concurrency` downloads run at once. Disk errors fail the download.
// - Void: a /stop or /clear voids what its cancelled requests bound, a /clear also the unbound ones received before it,
//   and unbound ones expire after `retentionMs`. Void records keep no path; their files are removed best effort here and
//   otherwise by the tmp archive (non-void paths are protected as run-record references).
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AsyncSemaphore } from "../core/async-semaphore.ts";
import { isPathInside } from "../contracts/paths.ts";
import type { DownloadResult } from "../integrations/open-platform/files.ts";
import type { Attachment, MemberRecords, ReplyContext } from "./records.ts";
import type { Scope } from "../core/layout.ts";

export const ATTACHMENT_LIMITS = {
  memberCount: 10,
  concurrency: 2,
  /** A request waits this long for the downloads it bound before it starts. */
  waitMs: 120_000,
  /** Unbound attachments are void after this. */
  retentionMs: 24 * 3600_000,
};
export type AttachmentLimits = typeof ATTACHMENT_LIMITS;

/** What an attachment event declares. */
export type AttachmentEvent = { fileId: string; kind: Attachment["kind"]; name: string; size?: number; mimeType?: string };

/** The platform's download (src/integrations/open-platform/files.ts downloadFile). */
export type AttachmentSource = (fileId: string, destination: string, options: { signal?: AbortSignal }) => Promise<DownloadResult>;

const KIND_LABEL: Record<Attachment["kind"], string> = { image: "图片", file: "文件", video: "视频" };

export const newAttachmentId = () => randomUUID().replaceAll("-", "").slice(0, 16);

export function receivedDir(tempDir: string): string {
  return join(tempDir, "received");
}

/** The user-facing label: `文件「a.pdf」`, or just `图片` when the event had no name. */
export function attachmentLabel(attachment: Pick<Attachment, "kind" | "name">): string {
  return attachment.name && attachment.name !== KIND_LABEL[attachment.kind] ? `${KIND_LABEL[attachment.kind]}「${attachment.name}」` : KIND_LABEL[attachment.kind];
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

/** A file name that is safe on every host: letters, digits, `._-`, at most 80 characters, never hidden. */
export function safeFileName(name: string, extension = ""): string {
  let base = name.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_").replace(/^[._]+/, "");
  const ext = /^\.[A-Za-z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : "";
  if (ext && !base.toLowerCase().endsWith(ext)) base += ext;
  const chars = [...base];
  if (chars.length > 80) base = chars.slice(chars.length - 80).join("").replace(/^[._]+/, "");
  return base || `attachment${ext}`;
}

/** Registered, not yet bound by a request and not void. */
export function unconsumed(records: Readonly<MemberRecords>): Attachment[] {
  return Object.values(records.attachments).filter(attachment => attachment.boundTo === undefined && attachment.state !== "void");
}

/** Arrived before the given point (an inbox item or a control): an older epoch, or the same one and not later. */
export function arrivedBefore(attachment: Pick<Attachment, "epoch" | "receivedAt">, point: { epoch?: number; receivedAt: number }): boolean {
  const epoch = point.epoch ?? 0;
  return attachment.epoch < epoch || (attachment.epoch === epoch && attachment.receivedAt <= point.receivedAt);
}

/** In the admission commit: the request takes every earlier unconsumed attachment. A cancelled request voids them. */
export function bindAttachments(records: MemberRecords, requestId: string, item: { epoch: number; receivedAt: number }, cancelled: boolean, now: number): Attachment[] {
  const bound = unconsumed(records).filter(attachment => arrivedBefore(attachment, item));
  for (const attachment of bound) {
    attachment.boundTo = requestId;
    if (cancelled) voidAttachment(attachment, now);
  }
  return cancelled ? bound.map(copy) : [];
}

/** Returns the attachment as it was (its path is what to remove), or undefined when it was void already. */
export function voidAttachment(attachment: Attachment, now: number): Attachment | undefined {
  if (attachment.state === "void") return undefined;
  const before = copy(attachment);
  attachment.state = "void";
  delete attachment.path;
  attachment.at = now;
  return before;
}

/** Void what matches; returns the previous records of the voided ones. */
export function voidWhere(records: MemberRecords, match: (attachment: Attachment) => boolean, now: number): Attachment[] {
  return Object.values(records.attachments).filter(match).flatMap(attachment => voidAttachment(attachment, now) ?? []);
}

/**
 * Maintenance: unbound attachments expire; records bound to a request that is gone (pruned after its retention) are
 * dropped with it. Returns the voided attachments.
 */
export function expireAttachments(records: MemberRecords, now: number, retentionMs = ATTACHMENT_LIMITS.retentionMs): Attachment[] {
  for (const [id, attachment] of Object.entries(records.attachments)) {
    if (attachment.boundTo !== undefined && attachment.state !== "void" && records.requests[attachment.boundTo] === undefined) delete records.attachments[id];
  }
  return voidWhere(records, attachment => attachment.boundTo === undefined && now - attachment.receivedAt > retentionMs, now);
}

/** The lines the model sees after the member's text. */
export function attachmentPrompt(attachments: readonly Attachment[]): string {
  if (!attachments.length) return "";
  const lines = attachments.map(attachment => {
    const label = attachmentLabel(attachment);
    switch (attachment.state) {
      case "ready": return `- ${label}，${formatBytes(attachment.actualSize ?? 0)}${attachment.mimeType ? `，类型 ${attachment.mimeType}` : ""}：${attachment.path!.replace(/\\/g, "/")}`;
      case "pending": return `- ${label}：等待下载超时，本次无法使用`;
      case "rejected": return `- ${label}：未接收，${attachment.error ?? "服务未接收"}`;
      case "failed": return `- ${label}：下载失败，${attachment.error ?? "原因未知"}`;
      default: return `- ${label}：已作废`;
    }
  });
  const images = attachments.some(attachment => attachment.state === "ready" && attachment.kind === "image") ? "图片可以用 read 工具查看。" : "";
  return `\n\n[用户在这条消息之前发送的附件]\n${lines.join("\n")}${images ? `\n${images}` : ""}`;
}

/** Remove an attachment's files (`<id>.part`, `<id>-*`) inside the member's own `received` directory; missing is fine. */
export async function removeAttachmentFiles(tempDir: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const dir = await ownReceivedDir(tempDir, false);
  if (dir === undefined) return;
  const names = await readdir(dir);
  for (const name of names) {
    if (ids.some(id => name === `${id}.part` || name.startsWith(`${id}-`))) await rm(join(dir, name), { force: true });
  }
}

/** The member's `received` directory, refused when it is not a plain directory inside the member's tmp. */
async function ownReceivedDir(tempDir: string, create: boolean): Promise<string | undefined> {
  const dir = receivedDir(tempDir);
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const root = await realpath(tempDir), actual = await realpath(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || actual === root || !isPathInside(actual, root)) throw new Error("附件接收目录不是用户 tmp 下的普通目录");
  return actual;
}

/** What the downloader needs from the service. */
export interface DownloadHost {
  read(space: Scope, phone: string): Promise<Readonly<MemberRecords>>;
  /** One commit on the member's records. */
  update<T>(space: Scope, phone: string, change: (records: MemberRecords) => T): Promise<T>;
  tempDir(space: Scope, phone: string): string;
  notify(reply: ReplyContext, text: string): void;
  report(error: unknown): void;
}

type Active = { controller: AbortController; space: Scope; phone: string };

/** Background downloads of pending attachments; at most `concurrency` at once across the process. */
export class AttachmentDownloads {
  readonly #slots: AsyncSemaphore;
  readonly #active = new Map<string, Active>();
  readonly #work = new Set<Promise<void>>();

  constructor(private readonly source: AttachmentSource, private readonly host: DownloadHost, private readonly signal: AbortSignal,
    readonly limits: AttachmentLimits = ATTACHMENT_LIMITS) {
    this.#slots = new AsyncSemaphore(limits.concurrency);
  }

  /** Start (or keep) the download of a pending attachment. */
  schedule(space: Scope, phone: string, id: string): void {
    if (this.signal.aborted || this.#active.has(id)) return;
    const active: Active = { controller: new AbortController(), space, phone };
    this.#active.set(id, active);
    const work = this.#run(id, active).catch(error => { if (!this.signal.aborted) this.host.report(error); })
      .finally(() => { if (this.#active.get(id) === active) this.#active.delete(id); });
    this.#work.add(work);
    void work.finally(() => this.#work.delete(work));
  }

  /** A voided attachment: stop its download (the record is already void, so nothing it finishes is kept). */
  cancel(ids: readonly string[]): void {
    for (const id of ids) this.#active.get(id)?.controller.abort(new Error("附件已作废"));
  }

  async idle(): Promise<void> {
    while (this.#work.size) await Promise.allSettled([...this.#work]);
  }

  async #run(id: string, active: Active): Promise<void> {
    const { space, phone } = active;
    const signal = AbortSignal.any([this.signal, active.controller.signal]);
    const release = await this.#slots.acquire(signal).catch(() => undefined);
    if (release === undefined) return;
    try {
      const records = await this.host.read(space, phone);
      const attachment = records.attachments[id];
      if (attachment?.state !== "pending" || signal.aborted) return;
      const tempDir = this.host.tempDir(space, phone);
      const dir = await ownReceivedDir(tempDir, true);
      await removeAttachmentFiles(tempDir, [id]);
      const part = join(dir!, `${id}.part`);
      let result: DownloadResult;
      try {
        result = await this.source(attachment.fileId, part, { signal });
      } catch (error) {
        await rm(part, { force: true }).catch(() => {});
        // Shutdown: stays pending, the next start downloads it again. Void: the record already says so.
        if (signal.aborted) return;
        await this.#settle(active, id, "failed", error instanceof Error ? error.message : String(error));
        return;
      }
      const final = join(dir!, `${id}-${safeFileName(result.fileName || attachment.name, result.mimeType)}`);
      try { await rename(part, final); }
      catch (error) {
        await rm(part, { force: true }).catch(() => {});
        await this.#settle(active, id, "failed", `保存文件失败（${(error as NodeJS.ErrnoException).code ?? String(error)}）`);
        return;
      }
      const kept = await this.host.update(space, phone, own => {
        const stored = own.attachments[id];
        if (stored?.state !== "pending") return false;
        stored.state = "ready"; stored.path = final; stored.actualSize = result.size; stored.at = Date.now();
        if (result.mimeType) stored.mimeType = result.mimeType;
        return true;
      });
      if (!kept) await rm(final, { force: true });
    } finally { release(); }
  }

  async #settle(active: Active, id: string, state: "failed", error: string): Promise<void> {
    const reply = await this.host.update(active.space, active.phone, own => {
      const stored = own.attachments[id];
      if (stored?.state !== "pending") return undefined;
      stored.state = state; stored.error = error; stored.at = Date.now();
      return stored.boundTo === undefined ? copy(stored.reply) : undefined;
    });
    // A bound attachment is explained in its request's prompt; an unbound one gets a notice now.
    const label = attachmentLabel((await this.host.read(active.space, active.phone)).attachments[id] ?? { kind: "file", name: "" });
    if (reply) this.host.notify(reply, `${label}下载失败：${error}。请重新发送。`);
  }
}

/** A plain copy of a record read inside a commit (transaction documents are proxies, which structuredClone refuses). */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
