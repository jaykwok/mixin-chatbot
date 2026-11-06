// Tests only: every document the bot defines, as Durable sees its definition (it reads `definition.checkpointWhen` at
// every commit).
import type { CheckpointPolicy } from "../../src/durable/checkpoint.ts";
import { IdentityDoc, MemberDirectory, SpaceDoc } from "../../src/durable/identity.ts";
import { ControlsDoc, InboxDoc } from "../../src/durable/inbox.ts";
import { MemberRecordsDoc, ReceiptsDoc } from "../../src/durable/records.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { ReclamationItems, ReclamationQueues } from "../../src/durable/results/queue.ts";

type Definition = { readonly kind: string; checkpointWhen: CheckpointPolicy };
/** Every document the bot defines (checkpoint.test.ts checks the kinds and that each uses checkpointDue). */
export const BOT_DOCUMENTS: readonly Definition[] = [SpaceDoc, MemberDirectory, IdentityDoc, InboxDoc, ControlsDoc, MemberRecordsDoc,
  ReceiptsDoc, ResultsDoc, ReclamationItems, ReclamationQueues].map(token => (token as unknown as { definition: Definition }).definition);
