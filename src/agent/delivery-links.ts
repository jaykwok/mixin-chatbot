import { getRelayConfig, LinkUnavailable, refreshRelayReference, type RelayConfig } from "../integrations/relay.ts";
import type { RelayIndex } from "../integrations/relay-index.ts";
import type { LinkNote } from "../durable/records.ts";

/** The text with every saved relay note rebuilt from its reference (a fresh download URL, the current note layout). */
export async function refreshDeliveryText(item: { text: string; attachments: readonly LinkNote[] }, signal?: AbortSignal,
  config: RelayConfig | null = getRelayConfig(), index?: RelayIndex): Promise<string> {
  let text = item.text;
  const unique = new Map<string, LinkNote>();
  for (const attachment of item.attachments) {
    const previous = unique.get(attachment.original);
    if (previous && JSON.stringify(previous.reference) !== JSON.stringify(attachment.reference)) {
      throw new LinkUnavailable("附件引用不一致");
    }
    unique.set(attachment.original, attachment);
  }
  for (const attachment of unique.values()) {
    signal?.throwIfAborted();
    if (!text.includes(attachment.original)) throw new LinkUnavailable("附件与正文不一致");
    const fresh = await refreshRelayReference(attachment.reference, signal, config, index);
    text = text.replaceAll(attachment.original, fresh.note);
  }
  return text;
}
