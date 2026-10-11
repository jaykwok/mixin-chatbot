import { expect, test } from "bun:test";
import { normalizeRelayUrlInput } from "../../scripts/config/relay-url.ts";

test.each([
  ["s3.example.test", "https://s3.example.test"],
  ["https://s3.example.test/", "https://s3.example.test"],
  ["http://localhost:9000", "http://localhost:9000"],
  ["http://127.0.0.1:9000/", "http://127.0.0.1:9000"],
  ["http://[::1]:9000", "http://[::1]:9000"],
  ["s3.oss-cn-hangzhou.aliyuncs.com", "https://s3.oss-cn-hangzhou.aliyuncs.com"],
] as const)("normalizes S3 endpoint %s", (input, expected) => {
  expect(normalizeRelayUrlInput(input)).toBe(expected);
});

test.each(["", "/endpoint", "ftp://host", "https:/example.com", "mailto:someone", "https://user:secret@host",
  "https://host/bucket", "https://host?sign=secret", "https://host#", "host\\path", "https://host/\nsecret"])(
  "rejects invalid endpoint %s", input => { expect(() => normalizeRelayUrlInput(input)).toThrow(); });
