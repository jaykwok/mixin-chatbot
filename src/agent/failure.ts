// 失败回执：把一次请求失败翻成群里能读、管理员能照着排查的一段话。
//
// 「请稍后再试」对群成员和管理员都是死路：群成员不知道该不该重试，管理员拿到的转述里没有
// 任何可定位的信息，而日志躺在服务器上通常没人去翻。所以给一句「出了什么事、这边还能不能
// 自救」，再附上模型服务自己的原文（脱敏、压成一行、截断）。修复步骤不写进群——管理员看
// 原文就知道该动哪里，写出来只是刷屏。
//
// 原文来源见 runtime.ts 的 readTurnFailure：Pi 把 provider 的报错写在 assistant 消息的
// errorMessage 上，额度耗尽、key 失效、限流都长这样。

/** 群聊里放不下 provider 动辄几千字的报文，原文只留够定位的一段。 */
const MAX_DETAIL_CHARS = 300;

/** 报错原文常把请求头或 URL 原样回显，进群前先抹掉里面的凭据。 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|ghp|xoxb|hf)-[A-Za-z0-9_-]{6,}/gi, "$1-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1***")
    .replace(
      /(["']?(?:api[_-]?key|apikey|access[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^"'\s,;}&]+/gi,
      "$1***"
    )
    .replace(/([?&](?:key|token|secret|sig|signature|password)=)[^&\s"']+/gi, "$1***");
}

// pi-ai 的 formatProviderError 会把状态码拼成 `429: <body>` 或 `<provider> (429): <body>`；
// 各家 SDK 自己的 message 则多是 `HTTP 401` / `403 status code (no body)` 这类写法。
const STATUS_PATTERNS: readonly RegExp[] = [
  /^\s*(?:[^\n()]{0,40}\()?(\d{3})\)?\s*:/,
  /\b(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*(\d{3})\b/i,
  /\b(\d{3})\s+(?:status code|error\b)/i,
];

/** 从报错原文里认出 HTTP 状态码；认不出返回 undefined。 */
export function extractHttpStatus(raw: string): number | undefined {
  for (const pattern of STATUS_PATTERNS) {
    const match = raw.match(pattern);
    if (!match) continue;
    const status = Number(match[1]);
    if (status >= 100 && status <= 599) return status;
  }
  return undefined;
}

interface FailureRule {
  /** 报错原文特征。 */
  pattern?: RegExp;
  /** 命中的 HTTP 状态码。 */
  statuses?: readonly number[];
  /** 一句话结论：出了什么事，以及用户自己还能不能补救。 */
  hint: string;
}

// 顺序即优先级：特征更具体的排前面。额度必须排在限流之前——额度耗尽的响应通常也是 429，
// 但「稍后再试」对它毫无意义；空回复排最后，它只是「没别的线索」时的兜底描述。
const FAILURE_RULES: readonly FailureRule[] = [
  {
    pattern: /群聊消息发送失败/,
    hint: "模型已经生成了回复，但发到群里失败了。多为平台限流或 callback key 失效，请管理员查看服务器日志里的发送状态码。",
  },
  {
    pattern: /models\.json|configure|未配置可用凭证/i,
    hint: "机器人这边的模型配置有问题，请联系管理员。",
  },
  {
    pattern:
      /insufficient[_ ]?(?:quota|balance|credits?)|out of (?:quota|credits?)|exceeded your current quota|no credits?\b|quota|余额不足|额度(?:已)?(?:用完|用尽|不足)|欠费|arrears|billing|payment required/i,
    statuses: [402],
    hint: "模型服务的额度或余额已经用完，请联系管理员。",
  },
  {
    pattern: /rate[_ ]?limit|too many requests|请求过于频繁|并发上限/i,
    statuses: [429],
    hint: "模型服务正在限流，稍等片刻再发一次；持续出现请联系管理员。",
  },
  {
    pattern:
      /invalid[_ ]?api[_ ]?key|incorrect api key|invalid token|unauthorized|authentication|permission denied|forbidden|鉴权失败/i,
    statuses: [401, 403],
    hint: "模型服务拒绝了当前凭证（key 无效、过期或没有该模型的权限），请联系管理员。",
  },
  {
    pattern: /model[^\n]{0,24}(?:not found|does not exist|不存在|未找到)|unknown model|no such model/i,
    statuses: [404],
    hint: "模型服务里找不到配置的模型 id，请联系管理员。",
  },
  {
    pattern:
      /context[_ ]?length|maximum context|context window|too many tokens|prompt is too long|上下文(?:过长|超限)/i,
    hint: "这轮对话的上下文超出了模型上限。发送 /clear 清空你在本群的会话历史后重试。",
  },
  {
    pattern:
      /etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|network error|timed?\s?out|超时|连接失败/i,
    hint: "机器人连不上模型服务（网络不通或超时），请联系管理员。",
  },
  {
    statuses: [500, 502, 503, 504, 529],
    hint: "模型服务自身故障或过载，通常过几分钟自行恢复；持续出现请联系管理员。",
  },
  {
    pattern: /未返回回复/,
    hint: "模型这一轮既没有输出文本也没有报错，属于异常空回复。可以重发一次；持续出现请联系管理员。",
  },
];

const FALLBACK_HINT = "这个失败没能自动归类，请把本条消息连同下面的原始错误转给管理员。";

function classifyFailure(raw: string, status: number | undefined): string {
  for (const rule of FAILURE_RULES) {
    if (rule.pattern?.test(raw)) return rule.hint;
    if (status !== undefined && rule.statuses?.includes(status)) return rule.hint;
  }
  return FALLBACK_HINT;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  return String(error);
}

/** 脱敏、压成一行并截断后的报错原文；没有可展示内容时返回空串。 */
function formatDetail(raw: string): string {
  const flat = redactSecrets(raw).replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  return flat.length > MAX_DETAIL_CHARS
    ? `${flat.slice(0, MAX_DETAIL_CHARS)}…（已截断）`
    : flat;
}

/** 群里那条失败回执的正文：一句能照着动手的结论 + 报错原文。 */
export function describeRequestFailure(error: unknown): string {
  const raw = errorText(error);
  const hint = classifyFailure(raw, extractHttpStatus(raw));
  const detail = formatDetail(raw);
  const head = `⚠️ 抱歉，处理您的请求时出错了。\n${hint}`;
  return detail ? `${head}\n原始错误：${detail}` : head;
}
