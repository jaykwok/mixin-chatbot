import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { unlink, writeFile } from "node:fs/promises";
import { CloseoutStore, fileDigest, freezeFile } from "../agent/deliverables.ts";
import { readBytes, type SendToolsOptions } from "../agent/send-tools.ts";
import { MAX_ATTACHMENT_BYTES } from "../core/config.ts";
import type { Member, MemberCall } from "./tools.ts";
import { activeRequest } from "./closeout.ts";

/** Bound to the invocation's persisted request, never a later value of member.current. */
export async function fileDelivery(store: CloseoutStore, member: Member, call: MemberCall, maxBytes = MAX_ATTACHMENT_BYTES): Promise<NonNullable<SendToolsOptions["fileDelivery"]>> {
  const item = await activeRequest(call.api, call.context);
  return async (source, name, signal, send) => {
    if (!item) throw new Error("没有正在执行的任务，不能发送文件");
    let download: string | undefined;
    try {
      if (source.kind === "remote") {
        const data = await readBytes(source, signal);
        download = join(member.places.tempDir, `${randomUUID()}-${name}`);
        await writeFile(download, data, { flag: "wx" });
        source = { kind: "local", path: download, size: data.length };
      }
      const sourcePath = source.path, sha256 = await fileDigest(sourcePath, signal, maxBytes);
      let file = store.files(item.session, item.requestId).find(each => each.sha256 === sha256);
      let reused = file !== undefined;
      if (!file) {
        // Registration already froze these exact bytes. Ordinary new sources still receive an exclusive copy.
        const registered = store.registrations(item.session, item.requestId).find(each => each.path === sourcePath && each.sha256 === sha256);
        const frozen = registered ?? await freezeFile(sourcePath, member.places.tempDir, item.requestId, maxBytes, signal, sha256);
        file = store.file({ path: frozen.path, size: frozen.size, sha256, name, session: item.session, requestId: item.requestId,
          mode: frozen.size > MAX_ATTACHMENT_BYTES ? "relay" : "direct" });
        reused = file.path !== frozen.path;
        if (!registered && file.path !== frozen.path) await unlink(frozen.path).catch(() => {});
      }
      if (file.state === "sent") return { mode: "direct", alreadySent: true };
      if (["uncertain", "sending"].includes(file.state)) throw new Error(file.deliveryId
        ? "此版本上次发送结果不确定，请先查看群消息；如未收到，用户可用 /deliver 补发已保存的交付计划。不要自动重发。"
        : "此版本上次发送结果不确定，请先查看群消息；如未收到，请用户在新消息中明确要求重新发送。当前任务不会自动重发。");
      if (file.mode === "relay" && file.state === "planned" && file.relay) return file.relay;
      // A newly copied snapshot was just checked; a reused one must still match its saved digest.
      if (reused && await fileDigest(file.path, signal, maxBytes) !== file.sha256) throw new Error("已保存的文件发生变化，拒绝发送");
      signal?.throwIfAborted();
      file = { ...file, state: "sending", attempts: file.attempts + 1, at: Date.now() }; store.saveFile(file);
      let dispatched = false;
      try {
        const result = await send({ kind: "local", path: file.path, size: file.size }, () => { dispatched = true; });
        store.saveFile({ ...file, mode: result.mode, state: result.mode === "relay" ? "planned" : "sent", ...(result.mode === "relay" ? { relay: result } : {}) });
        return result;
      } catch (error) {
        store.saveFile({ ...file, state: dispatched ? "uncertain" : "failed", error: String(error) }); throw error;
      }
    } finally { if (download) await unlink(download).catch(() => {}); }
  };
}
