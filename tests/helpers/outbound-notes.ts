import type { DeliveryAttachment } from "../../src/agent/delivery-store.ts";
import type { OutboundNotes } from "../../src/agent/send-tools.ts";

/** In-memory test outbox; production notes are persisted by DurableService. */
export function createOutboundNotes(onAdd?: (note: string, attachment?: DeliveryAttachment) => void): OutboundNotes {
  let notes: string[] = [], attachments: DeliveryAttachment[] = [];
  return {
    add(note, attachment) { onAdd?.(note, attachment); notes.push(note); if (attachment) attachments.push(attachment); },
    peek: () => [...notes], references: () => [...attachments],
    clear() { notes = []; attachments = []; },
  };
}
