// `mixin.send`: send_image and send_file for the Durable engine (D2-4; contract 2.4). The AgentSession engine's tools
// (src/agent/send-tools.ts) built for the calling member, through the same `memberTool` entry as the base tools: the
// identity decides the member, and the member's places decide which files may be sent.
//
// Model-only: the definitions say `exposure: "model-only"`, so codemode never lets a script call them (a message cannot
// be taken back); the model calls them one by one. Replay unsafe: an interrupted send is never repeated on recovery.
//
// Where a send goes is the service's part (D3): the member's IM callback URL and where a relay link note waits for the
// member's reply (the outbox, contract 2.6) come from `SendDelivery`. Until then only tests provide one.
import type { RelayConfig } from "../integrations/relay.ts";
import { buildSendTools, type OutboundNotes } from "../agent/send-tools.ts";
import { type BaseToolsOptions, type Member, memberTool, type MemberTool } from "./tools.ts";

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
}

function definitions(options: SendToolsOptions, member: Member | undefined) {
  return buildSendTools({
    getCallbackUrl: () => {
      if (member === undefined) throw new Error("catalogue only");
      return options.delivery.callbackUrl(member);
    },
    groupId: options.groupId,
    workspaceDir: member?.places.workspaceDir ?? "catalogue",
    tempDir: member?.places.tempDir ?? "catalogue",
    relay: options.relay,
    notes: member === undefined ? { add() { throw new Error("catalogue only"); }, peek: () => [], references: () => [], clear() {} }
      : options.delivery.notes(member),
  });
}

/** The two send tools; `mixin.send` declares them to the model (./registry.ts). */
export function sendMemberTools(options: SendToolsOptions): MemberTool[] {
  return definitions(options, undefined).map((definition) => memberTool(definition, options, (member) => definitions(options, member)));
}
