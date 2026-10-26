import type { OutboundNotes, SendChannel } from "../../src/agent/send-tools.ts";
import type { LinkNote } from "../../src/durable/records.ts";

/** In-memory link notes; production notes are persisted in the request record by DurableService. */
export function createOutboundNotes() {
  const items: LinkNote[] = [];
  const notes: OutboundNotes & { peek(): string[]; references(): LinkNote[] } = {
    async add(note) { items.push(note); },
    peek: () => items.map(note => note.original),
    references: () => [...items],
  };
  return notes;
}

/** A send channel that records what the tools sent directly. */
export function recordingChannel() {
  const sent: { kind: "file" | "image"; name: string; size: number }[] = [];
  const channel: SendChannel = {
    async file(file, signal, dispatched) { signal?.throwIfAborted(); dispatched(); sent.push({ kind: "file", name: file.name, size: file.size }); },
    async image(image, signal, dispatched) { signal?.throwIfAborted(); dispatched(); sent.push({ kind: "image", name: image.name, size: image.size }); },
  };
  return { sent, channel };
}
