import { expect, test } from "bun:test";
import { normalizeRelayUrlInput } from "../../scripts/config/relay-url.ts";

test.each([
  ["127.0.0.1:5244/dav/relay", "webdav", "http://127.0.0.1:5244/dav/relay/"],
  ["localhost:5244/dav/relay/", "webdav", "http://localhost:5244/dav/relay/"],
  ["127.0.0.1:443/dav/relay", "webdav", "http://127.0.0.1:443/dav/relay/"],
  ["192.168.1.20:5244/dav/relay", "webdav", "http://192.168.1.20:5244/dav/relay/"],
  ["10.0.0.2:5244/dav/relay", "webdav", "http://10.0.0.2:5244/dav/relay/"],
  ["172.16.0.2:5244/dav/relay", "webdav", "http://172.16.0.2:5244/dav/relay/"],
  ["172.31.0.2:5244/dav/relay", "webdav", "http://172.31.0.2:5244/dav/relay/"],
  ["169.254.1.2:5244/dav/relay", "webdav", "http://169.254.1.2:5244/dav/relay/"],
  ["[::1]:5244/dav/relay", "webdav", "http://[::1]:5244/dav/relay/"],
  ["[fd12::1]:5244/dav/relay", "webdav", "http://[fd12::1]:5244/dav/relay/"],
  ["[fe80::1]:5244/dav/relay", "webdav", "http://[fe80::1]:5244/dav/relay/"],
  ["172.32.0.2:5244/dav/relay", "webdav", "https://172.32.0.2:5244/dav/relay/"],
  ["dav.example.com/remote.php/dav/files/bot", "webdav", "https://dav.example.com/remote.php/dav/files/bot/"],
  ["files.example.com/d/relay", "public", "https://files.example.com/d/relay/"],
  [" FILES.EXAMPLE.COM/d/relay/ ", "public", "https://files.example.com/d/relay/"],
  ["files.example.com/d/网盘/relay", "public", "https://files.example.com/d/%E7%BD%91%E7%9B%98/relay/"],
  ["files.example.com/d/%E7%BD%91%E7%9B%98/relay/", "public", "https://files.example.com/d/%E7%BD%91%E7%9B%98/relay/"],
  ["https://127.0.0.1:5244/dav/relay", "webdav", "https://127.0.0.1:5244/dav/relay/"],
  ["http://dav.example.com:5244/dav/relay", "webdav", "http://dav.example.com:5244/dav/relay/"],
  ["http://files.example.com/d/relay", "public", "http://files.example.com/d/relay/"],
] as const)("目录地址补全保留路径、显式协议及端口：%s（%s）", (input, kind, expected) => {
  expect(normalizeRelayUrlInput(input, kind)).toBe(expected);
});

test.each([
  undefined, "", "   ", "ftp://files.example.com/relay", "/dav/relay", "//files.example.com/d/relay",
  "https:/files.example.com/d/relay", "https:files.example.com/d/relay", "mailto:bot@example.com",
  "not a host/d/relay", "files.example.com:99999/d/relay", "files.example.com\\d\\relay",
  "files.example.com/\nd/relay", "https://", "http://user:private-password@files.example.com/dav/relay",
  "user:private-password@files.example.com/dav/relay", "files.example.com/d/relay?sign=private-token",
  "files.example.com/d/relay?", "https://files.example.com/d/relay#fragment", "files.example.com/d/relay#",
])("拒绝无效地址、URL 凭据及文件签名参数：%s", input => {
  expect(() => normalizeRelayUrlInput(input, "webdav")).toThrow();
});
