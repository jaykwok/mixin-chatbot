// `mixin.send`: send_image and send_file for the Durable engine. The send tools
// (src/agent/send-tools.ts) built for the calling member, through the same `memberTool` entry as the base tools: the
// identity decides the member, and the member's places decide which files may be sent.
//
// Model-only: the definitions say `exposure: "model-only"`, so codemode never lets a script call them (a message cannot
// be taken back); the model calls them one by one. Replay unsafe: an interrupted send is never repeated on recovery.
//
// The service provides `SendDelivery`: the member's IM callback URL and the outbox where relay link notes wait
// for the member's reply.
import type { RelayConfig } from "../integrations/relay.ts";
import { buildSendTools, type OutboundNotes } from "../agent/send-tools.ts";
import { type BaseToolsOptions, type Member, memberTool, type MemberTool } from "./tools.ts";
import type { CloseoutStore } from "../agent/deliverables.ts";
import { fileDelivery } from "./file-delivery.ts";

/** Where the calling member's sends go. */
export interface SendDelivery {
  /** The member's IM callback URL, read at each send (the bot key may rotate). */
  callbackUrl(member: Member): string;
  /** Where a relay link note waits for the member's reply. */
  notes(member: Member): OutboundNotes;
}

export interface SendToolsOptions extends Pick<BaseToolsOptions, "root" | "groupId" | "venvDir"> {
  /** The large-file relay, or null when none is configured. Fixed per registry: it also shapes send_file's description. */
  relay: RelayConfig | null;
  delivery: SendDelivery;
  closeout?: CloseoutStore;
}

function definitions(options: SendToolsOptions, member: Member | undefined, tracked?: import("../agent/send-tools.ts").SendToolsOptions["fileDelivery"]) {
  return buildSendTools({
    getCallbackUrl: () => {
      if (member === undefined) throw new Error("catalogue only");
      return options.delivery.callbackUrl(member);
    },
    groupId: options.groupId,
    workspaceDir: member?.places.workspaceDir ?? "catalogue",
    tempDir: member?.places.tempDir ?? "catalogue",
    relay: options.relay,
    ...(tracked ? { fileDelivery: tracked } : {}),
    notes: member === undefined ? { add() { throw new Error("catalogue only"); }, peek: () => [], references: () => [], clear() {} }
      : options.delivery.notes(member),
  });
}

/** The two send tools; `mixin.send` declares them to the model (./registry.ts). */
export function sendMemberTools(options: SendToolsOptions): MemberTool[] {
  return definitions(options, undefined).map((definition) => memberTool(definition, options, async (member, call) => definitions(options, member,
    options.closeout && definition.name === "send_file" ? await fileDelivery(options.closeout, member, call, options.relay?.maxBytes) : undefined)));
}
