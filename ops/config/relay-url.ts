/** The wizard accepts a bare host; saved configuration always has an explicit scheme. */
export function normalizeRelayUrlInput(value: string | undefined): string {
  const input = value?.trim() ?? "";
  if (!input || input.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(input)) throw new Error("请输入 S3 服务端点");
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  if (!hasScheme && /^[a-z][a-z\d+.-]*:(?!\d+(?:\/|$))/i.test(input)) throw new Error("请输入有效的 http:// 或 https:// 地址");
  let url: URL;
  try { url = new URL(hasScheme ? input : "https://" + input); }
  catch { throw new Error("请输入有效的 S3 服务端点"); }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("只支持 http:// 或 https://");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || /[?#]/.test(input)) {
    throw new Error("服务端点不能含桶路径、账号、查询参数或片段");
  }
  return url.origin;
}

/** Region named by well-known endpoints; only a wizard default, never a validation rule. */
export function suggestRelayRegion(endpoint: string): string | undefined {
  const host = new URL(endpoint).hostname;
  // COS regions always contain a dash, which excludes service hosts such as cos.accelerate.myqcloud.com.
  return /(?:^|\.)cos\.([a-z]+-[a-z0-9-]+)\.myqcloud\.com$/.exec(host)?.[1]
    ?? /^s3[.-]([a-z]+-[a-z0-9-]+)\.amazonaws\.com$/.exec(host)?.[1]
    ?? (host.endsWith(".r2.cloudflarestorage.com") ? "auto" : undefined);
}
