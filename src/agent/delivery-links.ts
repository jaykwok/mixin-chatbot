import { getRelayConfig, refreshRelayReference, type RelayConfig } from "../integrations/relay.ts";
import type { RelayIndex } from "../integrations/relay-index.ts";
import type { PendingDelivery, DeliveryAttachment } from "./delivery-store.ts";

/** Delivery uses explicit references; legacy text conversion belongs to the one-time migration. */
export async function refreshDeliveryText(item: Pick<PendingDelivery, "text" | "attachments" | "blockedReason">, signal?: AbortSignal,
  config: RelayConfig | null = getRelayConfig(), index?: RelayIndex): Promise<string> {
  if (item.blockedReason) throw new Error(item.blockedReason + "；待补发记录已保留，请联系管理员处理");
  let text = item.text;
  const attachments = item.attachments;
  const unique = new Map<string, DeliveryAttachment>();
  for (const attachment of attachments) {
    const previous = unique.get(attachment.original);
    if (previous && JSON.stringify(previous.reference) !== JSON.stringify(attachment.reference)) {
      throw new Error("附件引用不一致，待补发记录已保留");
    }
    unique.set(attachment.original, attachment);
  }
  for (const attachment of unique.values()) {
    signal?.throwIfAborted();
    if (!text.includes(attachment.original)) throw new Error("附件与待补发正文不一致，记录已保留");
    const fresh = await refreshRelayReference(attachment.reference, signal, config, index);
    const prefix = attachment.original.slice(0, attachment.original.indexOf("\n") + 1);
    text = text.replaceAll(attachment.original, prefix + fresh.url + fresh.expiry);
  }
  return text;
}
