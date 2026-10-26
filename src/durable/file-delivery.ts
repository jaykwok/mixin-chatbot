import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { unlink, writeFile } from "node:fs/promises";
import { fileDigest, freezeFile } from "../agent/deliverables.ts";
import { readBytes, SendNotConfirmed, type SendToolsOptions } from "../agent/send-tools.ts";
import { NATIVE_FILE_MAX_BYTES } from "../core/config.ts";
import type { Member, MemberCall } from "./tools.ts";
import { memberRecords, recordsOf, type FileSend } from "./records.ts";

type Active = { requestId: string; phone: string };

/** Change the file send in the run record (a commit of the calling invocation). */
async function saveFile(call: MemberCall, item: Active, file: FileSend): Promise<void> {
  await call.api.commit(async tx => {
    const record = (await recordsOf(tx, item.phone)).requests[item.requestId];
    if (!record) throw new Error("任务记录不存在，不能记录文件发送");
    const index = record.files.findIndex(each => each.id === file.id);
    if (index < 0) record.files.push(structuredClone(file));
    else record.files[index] = structuredClone(file);
  }, call.context);
}

/** Bound to the invocation's persisted request, never a later request of the member. */
export function fileDelivery(member: Member, call: MemberCall, item: Active, maxBytes = NATIVE_FILE_MAX_BYTES): NonNullable<SendToolsOptions["fileDelivery"]> {
  return async (source, name, signal, send) => {
    let download: string | undefined;
    try {
      if (source.kind === "remote") {
        const data = await readBytes(source, signal);
        download = join(member.places.tempDir, `${randomUUID()}-${name}`);
        await writeFile(download, data, { flag: "wx" });
        source = { kind: "local", path: download, size: data.length };
      }
      const sourcePath = source.path, sha256 = await fileDigest(sourcePath, signal, maxBytes);
      const record = (await memberRecords(call.api, item.phone, call.context)).requests[item.requestId];
      if (!record || record.closedAt !== undefined) throw new Error("任务已结束，不能发送文件");
      let file = record.files.find(each => each.sha256 === sha256);
      let reused = file !== undefined;
      if (!file) {
        // Registration already froze these exact bytes. Ordinary new sources still receive an exclusive copy.
        const registered = record.deliverables.find(each => each.path === sourcePath && each.sha256 === sha256);
        const frozen = registered ?? await freezeFile(sourcePath, member.places.tempDir, item.requestId, maxBytes, signal, sha256);
        file = { id: randomUUID(), name, path: frozen.path, size: frozen.size, sha256, mode: frozen.size > NATIVE_FILE_MAX_BYTES ? "relay" : "direct",
          state: "planned", attempts: 0, at: Date.now() };
        await saveFile(call, item, file);
        reused = false;
      }
      if (file.state === "sent") return { mode: "direct", alreadySent: true };
      if (file.state === "uncertain" || file.state === "sending") {
        // Run-time sends belong to no delivery plan and are never retried: only a new request can resend.
        throw new Error("此版本上次发送结果不确定，请先查看会话消息；如未收到，请用户在新消息中明确要求重新发送。当前任务不会自动重发。");
      }
      if (file.mode === "relay" && file.state === "planned" && file.relay) return { mode: "relay", ...file.relay };
      // A newly copied snapshot was just checked; a reused one must still match its saved digest.
      if (reused && await fileDigest(file.path, signal, maxBytes) !== file.sha256) throw new Error("已保存的文件发生变化，拒绝发送");
      signal?.throwIfAborted();
      file = { ...file, state: "sending", attempts: file.attempts + 1, at: Date.now() };
      await saveFile(call, item, file);
      let dispatched = false;
      try {
        const result = await send({ kind: "local", path: file.path, size: file.size }, () => { dispatched = true; });
        await saveFile(call, item, { ...file, mode: result.mode, state: result.mode === "relay" ? "planned" : "sent",
          ...(result.mode === "relay" ? { relay: { url: result.url, note: result.note, attachment: result.attachment, size: result.size } } : {}) });
        return result;
      } catch (error) {
        const uncertain = error instanceof SendNotConfirmed ? error.uncertain : dispatched;
        await saveFile(call, item, { ...file, state: uncertain ? "uncertain" : "failed", error: String(error) }).catch(() => {});
        throw error;
      }
    } finally { if (download) await unlink(download).catch(() => {}); }
  };
}
