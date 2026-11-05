// The three operation-log redactions (TypeScript, native Bash, Windows PowerShell) apply one rule set: each runs the
// same sample table and must agree with scripts/lib/redact.ts, which in turn must leave none of the secrets behind.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../../scripts/lib/redact.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const quotePS = (text: string) => "'" + text.replaceAll("'", "''") + "'";

// [sample, what the redacted text must be]. One line each.
const samples: [string, string][] = [
  ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic ***"],
  ["Authorization: Bearer abc.def-ghi", "Authorization: Bearer ***"],
  ["curl -H 'Authorization: Bearer tok_123'", "curl -H 'Authorization: Bearer ***'"],
  ['api_key=abc123 API-KEY: "xyz789"', 'api_key=*** API-KEY: "***"'],
  ['{"access_token":"tok-value","secret": "s3cr3t"}', '{"access_token":"***","secret": "***"}'],
  ["passwd=hunter2; password: 'quoted'", "passwd=***; password: '***'"],
  ["https://user:pa55@host.example/path", "https://***@host.example/path"],
  ["GET /x?sig=abc&sign=def&signature=ghi&key=k1&token=t1#frag", "GET /x?sig=***&sign=***&signature=***&key=***&token=***"],
  ["sk-abcdefgh1234 ghp_ABCDEF123456 github_pat_ABCDEF123456 hf_abcdefghij", "sk-*** ghp_*** github_pat_*** hf_***"],
  ["\x1b[31mred\x1b[0m plain", "red plain"],
  ["中文说明 password=中文值，继续", "中文说明 password=***"],
  ["nothing secret here: tokens are fine", "nothing secret here: tokens are fine"],
];

test("the TypeScript rules redact every sample", () => {
  for (const [sample, expected] of samples) expect(redactSecrets(sample), sample).toBe(expected);
});

test.skipIf(!bash || !existsSync(bash))("native Bash diagnostics redact the same samples to the same text", async () => {
  const f = await tempFixture("redaction-bash-");
  try {
    const input = join(f.root, "samples.txt"), script = join(f.root, "redact.sh");
    await writeFile(input, samples.map(([sample]) => sample).join("\n") + "\n");
    await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
. '${posix(join(project, "scripts/lib/operation-log.sh"))}'
while IFS= read -r line; do operation_redact "$line"; printf '\\n'; done < "$1"
`);
    const child = Bun.spawn([bash!, posix(script), posix(input)], { env: { ...process.env, LC_ALL: "en_US.UTF-8" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(0);
    expect(out.split("\n").slice(0, -1)).toEqual(samples.map(([, expected]) => expected));
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows PowerShell diagnostics redact the same samples to the same text", async () => {
  const f = await tempFixture("redaction-powershell-");
  try {
    const input = join(f.root, "samples.json"), output = join(f.root, "redacted.json"), script = join(f.root, "redact.ps1");
    await writeFile(input, JSON.stringify(samples.map(([sample]) => sample)));
    await writeFile(script, "\uFEFF" + [
      "$ErrorActionPreference='Stop'",
      `. ${quotePS(join(project, "scripts/lib/operation-log.ps1"))}`,
      "$samples = [IO.File]::ReadAllText($env:FIXTURE_INPUT, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json",
      "$redacted = @(foreach ($sample in $samples) { Protect-OperationMessage $sample })",
      "[IO.File]::WriteAllText($env:FIXTURE_OUTPUT, (ConvertTo-Json -Compress -InputObject $redacted), [Text.UTF8Encoding]::new($false))",
    ].join("\r\n"));
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { env: { ...process.env, FIXTURE_INPUT: input, FIXTURE_OUTPUT: output }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(samples.map(([, expected]) => expected));
  } finally { await f.cleanup(); }
}, 30_000);
