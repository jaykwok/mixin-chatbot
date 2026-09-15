/** 只根据输入识别本机/私有地址，不查询 DNS，也不连接后端。 */
function localUploadHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") return true;
  // IPv6 私有地址 fc00::/7 和链路本地地址 fe80::/10。
  if (/^\[(?:f[cd][\da-f]{2}:|fe[89ab][\da-f]:)/.test(host)) return true;
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [first, second] = octets.map(Number);
  return first === 127 || first === 10 || first === 192 && second === 168 ||
    first === 172 && second! >= 16 && second! <= 31 || first === 169 && second === 254;
}

/** 交互输入允许省略协议；配置文件仍保存完整 URL，运行时无需猜测。 */
export function normalizeRelayUrlInput(value: string | undefined, kind: "webdav" | "public"): string {
  const input = value?.trim() ?? "";
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const invalid = "请输入目录地址，如 127.0.0.1:5244/dav/relay/ 或 files.example.com/d/relay/";
  if (!input || input.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(input) ||
      // localhost:5244 是地址；https:/example.com、mailto:... 等不是省略协议的地址。
      (!hasScheme && /^[a-z][a-z\d+.-]*:(?!\d+(?:[/?#]|$))/i.test(input))) {
    throw new Error(invalid);
  }
  let url: URL;
  try { url = new URL(hasScheme ? input : "https://" + input); }
  catch { throw new Error(invalid); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http:// 或 https://");
  if (url.username || url.password) throw new Error("账号和密码请在后续认证项中填写，不要放在 URL 中");
  if (input.includes("?") || input.includes("#")) throw new Error("请填写目录地址，不要包含查询参数、下载签名或 # 片段");
  if (!hasScheme && kind === "webdav" && localUploadHost(url.hostname)) {
    // 从原输入重新解析，保留显式端口（例如 :443），避免切换协议时丢失默认端口。
    url = new URL("http://" + input);
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}
