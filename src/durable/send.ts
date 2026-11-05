// `mixin.send`: send_image and send_file for the Durable engine (src/agent/send-tools.ts), run for the calling member
// like every member tool: the identity decides the member, and the member's places decide which files may be sent.
//
// Model-only (`callers: ["model"]`): codemode never lets a script call them (a message cannot be taken back); the model
// calls them one by one. Replay unsafe: an interrupted send is never repeated on recovery.
//
// Every send goes to the reply context of the invocation's own request (its run record), never to a later message of
// the member. Relay link notes and file send states are written to that run record in the invocation's commits.
import type { RelayConfig } from "../integrations/relay.ts";
import type { SendOutcome } from "../integrations/open-platform/messages.ts";
import { sendTools, SendNotConfirmed, type SendChannel, type SendContext } from "../agent/send-tools.ts";
import { type BaseToolsOptions, type Member, type MemberCall, memberTool, type MemberTool } from "./tools.ts";
import { fileDelivery } from "./file-delivery.ts";
import { activeRequest } from "./closeout.ts";
import { type Outbound, sendFileMessage, sendImageMessage } from "./outbound.ts";
import { recordsOf, type ReplyContext } from "./records.ts";

export interface SendToolsOptions extends Pick<BaseToolsOptions, "layout" | "scope" | "venvDir"> {
  /** The large-file relay, or null when none is configured. Fixed per registry: it also shapes send_file's description. */
  relay: RelayConfig | null;
  outbound: Outbound;
}

function confirmed(outcome: SendOutcome, what: string): void {
  if (outcome.status === "sent") return;
  if (outcome.status === "uncertain") {
    throw new SendNotConfirmed(`${what}发送结果不确定（${outcome.reason}），可能已经送达；不要自动重发，请在回复中说明。`, true);
  }
  throw new SendNotConfirmed(`${what}发送失败：${outcome.reason}`, false);
}

export function sendChannel(outbound: Outbound, reply: ReplyContext): SendChannel {
  return {
    async file(file, signal, dispatched) {
      confirmed(await sendFileMessage(outbound, reply, file, signal, dispatched), "文件");
    },
    async image(image, signal, dispatched) {
      confirmed(await sendImageMessage(outbound, reply, image, signal, dispatched), "图片");
    },
  };
}

/** The calling member's sending context: its running request's reply target and run record. */
async function sendContext(options: SendToolsOptions, member: Member, call: MemberCall): Promise<SendContext> {
  const item = await activeRequest(call.api, call.context);
  if (!item) throw new Error("没有正在执行的任务，不能发送");
  const active = { requestId: item.requestId, phone: item.phone };
  return {
    channel: sendChannel(options.outbound, item.record.reply),
    workspaceDir: member.places.workspaceDir,
    tempDir: member.places.tempDir,
    fileDelivery: fileDelivery(member, call, active, options.relay?.maxBytes),
    notes: {
      add: note => call.api.commit(async tx => {
        const record = (await recordsOf(tx, active.phone)).requests[active.requestId];
        if (!record) throw new Error("任务记录不存在，不能保存外链");
        if (!record.notes.some(saved => saved.original === note.original && saved.reference.url === note.reference.url
          && saved.reference.backend === note.reference.backend)) record.notes.push(structuredClone(note));
      }, call.context),
    },
  };
}

/** The two send tools; `mixin.send` declares them to the model (./registry.ts). */
export function sendMemberTools(options: SendToolsOptions): MemberTool[] {
  return sendTools(options.relay, (member, call) => sendContext(options, member, call)).map((spec) => memberTool(spec, options));
}
