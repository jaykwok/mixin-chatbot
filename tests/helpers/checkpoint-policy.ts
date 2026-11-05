// Tests only: the checkpoint policy of the bot's own documents, replaced on their definitions (Durable reads
// `definition.checkpointWhen` at every commit). Writing as an older release did (never a base) or crossing a base on every
// change needs the real documents, also inside a running service; production code has one fixed policy.
import { checkpointDue, type CheckpointPolicy } from "../../src/durable/checkpoint.ts";
import { IdentityDoc, MemberDirectory, SpaceDoc } from "../../src/durable/identity.ts";
import { ControlsDoc, InboxDoc } from "../../src/durable/inbox.ts";
import { MemberRecordsDoc, ReceiptsDoc } from "../../src/durable/records.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { ReclamationItems, ReclamationQueues } from "../../src/durable/results/queue.ts";

type Definition = { readonly kind: string; checkpointWhen: CheckpointPolicy };
/** Every document the bot defines (checkpoint.test.ts checks the kinds and that each uses checkpointDue). */
export const BOT_DOCUMENTS: readonly Definition[] = [SpaceDoc, MemberDirectory, IdentityDoc, InboxDoc, ControlsDoc, MemberRecordsDoc,
  ReceiptsDoc, ResultsDoc, ReclamationItems, ReclamationQueues].map(token => (token as unknown as { definition: Definition }).definition);

/** An older release: never a base. */
export const NEVER: CheckpointPolicy = () => false;

/** Every bot document under `policy` until the returned function restores the production one. */
export function useCheckpointPolicy(policy: CheckpointPolicy): () => void {
  for (const definition of BOT_DOCUMENTS) definition.checkpointWhen = policy;
  return () => { for (const definition of BOT_DOCUMENTS) definition.checkpointWhen = checkpointDue; };
}
