// Current projection contract; the statistics ledger is independent of session storage.
export interface StatsRecord {
  type?: string; timestamp?: string; provider?: string; modelId?: string; model?: string; kind?: string; usage?: Record<string, unknown>;
  message?: { role?: string; command?: boolean; provider?: string; model?: string; content?: { type: string; name?: string }[];
    usage?: Record<string, unknown>; toolName?: string; isError?: boolean; details?: { fileId?: string };
    /** 工具运行中发起的子调用（Pi 的 nestedCalls）：只留被调用的工具名和记录是否完整。 */
    nested?: { names: string[]; complete: boolean } };
}
