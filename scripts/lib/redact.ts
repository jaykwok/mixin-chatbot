// Shared bootstrap-safe redaction: no configuration or package imports.
export function redactSecrets(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b((?:sk|pk|ghp|xoxb|hf)[-_]|github_pat_)[A-Za-z0-9_-]{6,}/gi, "$1***")
    .replace(/(Bearer\s+)[^\s"',;]+/gi, "$1***")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?)[^"'\s,;}&]+/gi, "$1***")
    .replace(/([?&](?:key|token|secret|sig|sign|signature|password)=)[^&\s"']+/gi, "$1***")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1***@")
    .replace(/\/webhook\/[a-f\d]{64}\b/gi, "/webhook/***");
}
