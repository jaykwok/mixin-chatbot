import type { Member, MemberCall, MemberPlaces, MemberToolResult, MemberToolSpec } from "../../src/durable/tools.ts";

/** Places for a tool that takes them from elsewhere (the send tools' context); nothing runs there. */
const NOWHERE: MemberPlaces = { workspaceDir: "nowhere", tempDir: "nowhere", indexPath: "nowhere", venvDir: "nowhere" };

export interface MemberRun {
  places?: MemberPlaces;
  phone?: string;
  signal?: AbortSignal;
  /** The Durable invocation, for a tool that reads or commits (default: none). */
  api?: MemberCall["api"];
}

/**
 * Runs a member tool as `memberTool` does once it resolved the calling member, without Durable: no identity check,
 * argument validation, JSON copy or error result; refusals and failures reject.
 */
export function runMemberTool(tool: MemberToolSpec, args: unknown, run: MemberRun = {}): Promise<MemberToolResult> {
  const member: Member = { phone: run.phone ?? "test", places: run.places ?? NOWHERE, conversationId: 0 as Member["conversationId"] };
  return tool.run(args as never, member, { api: run.api as MemberCall["api"], context: undefined as never, callId: "test", signal: run.signal });
}

/** The tool named `name`. */
export function toolNamed<T extends { readonly name: string }>(tools: readonly T[], name: string): T {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}
