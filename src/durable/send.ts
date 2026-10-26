// `mixin.send`: send_image and send_file for the Durable engine. The send tools (src/agent/send-tools.ts) built for the
// calling member, through the same `memberTool` entry as the base tools: the identity decides the member, and the
// member's places decide which files may be sent.
//
// Model-only: the definitions say `exposure: "model-only"`, so codemode never lets a script call them (a message cannot
// be taken back); the model calls them one by one. Replay unsafe: an interrupted send is never repeated on recovery.
//
// Every send goes to the reply context of the invocation's own request (its run record), never to a later message of
// the member. Relay link notes and file send states are written to that run record in the invocation's commits.
import type { RelayConfig } from "../integrations/relay.ts";
import type { SendOutcome } from "../integrations/open-platform/messages.ts";
import { buildSendTools, SendNotConfirmed, type SendChannel } from "../agent/send-tools.ts";
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

const catalogueChannel: SendChannel = { file: async () => { throw new Error("catalogue only"); }, image: async () => { throw new Error("catalogue only"); } };

function catalogue(options: SendToolsOptions) {
  return buildSendTools({ channel: catalogueChannel, workspaceDir: "catalogue", tempDir: "catalogue", relay: options.relay,
    notes: { add: async () => { throw new Error("catalogue only"); } } });
}

async function definitions(options: SendToolsOptions, member: Member, call: MemberCall) {
  const item = await activeRequest(call.api, call.context);
  if (!item) throw new Error("没有正在执行的任务，不能发送");
  const active = { requestId: item.requestId, phone: item.phone };
  return buildSendTools({
    channel: sendChannel(options.outbound, item.record.reply),
    workspaceDir: member.places.workspaceDir,
    tempDir: member.places.tempDir,
    relay: options.relay,
    fileDelivery: fileDelivery(member, call, active, options.relay?.maxBytes),
    notes: {
      add: note => call.api.commit(async tx => {
        const record = (await recordsOf(tx, active.phone)).requests[active.requestId];
        if (!record) throw new Error("任务记录不存在，不能保存外链");
        if (!record.notes.some(saved => saved.original === note.original && saved.reference.url === note.reference.url
          && saved.reference.backend === note.reference.backend)) record.notes.push(structuredClone(note));
      }, call.context),
    },
  });
}

/** The two send tools; `mixin.send` declares them to the model (./registry.ts). */
export function sendMemberTools(options: SendToolsOptions): MemberTool[] {
  return catalogue(options).map((definition) => memberTool(definition, options, async (member, call) =>
    (await definitions(options, member, call)).filter(each => each.name === definition.name)));
}
