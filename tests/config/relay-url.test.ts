import { expect, test } from "bun:test";
import { normalizeRelayUrlInput, suggestRelayRegion } from "../../scripts/config/relay-url.ts";

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

test.each([
  ["https://cos.ap-chengdu.myqcloud.com", "ap-chengdu"],
  ["https://bot-1250000000.cos.ap-chengdu.myqcloud.com", "ap-chengdu"],
  ["https://cos.accelerate.myqcloud.com", undefined],
  ["https://s3.us-west-2.amazonaws.com", "us-west-2"],
  ["https://s3-eu-west-1.amazonaws.com", "eu-west-1"],
  ["https://s3.amazonaws.com", undefined],
  ["https://0123456789abcdef.r2.cloudflarestorage.com", "auto"],
  ["https://s3.oss-cn-hangzhou.aliyuncs.com", undefined],
  ["http://127.0.0.1:9000", undefined],
] as const)("suggests the region named by %s", (endpoint, region) => {
  expect(suggestRelayRegion(endpoint)).toBe(region);
});
