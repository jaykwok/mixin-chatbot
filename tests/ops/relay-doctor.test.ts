import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

for (const shell of ["powershell", "bash"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    shell + " S3 doctor checks required fields without treating untested cloud permissions as a permanent warning", async () => {
      const f = await tempFixture("relay-doctor-");
      const configPath = join(f.root, "relay.json"), runner = join(f.root, shell === "powershell" ? "check.ps1" : "check.sh");
      try {
        if (shell === "powershell") {
          await writeFile(runner, String.fromCharCode(0xfeff) + [
            "$ErrorActionPreference='Stop'", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
            "$tokens=$null; $errors=$null",
            "$ast=[Management.Automation.Language.Parser]::ParseFile($env:DOCTOR_SOURCE,[ref]$tokens,[ref]$errors)",
            "if($errors){throw 'syntax error'}",
            "foreach($name in @('Get-RelayDoctorRows','New-DoctorRow')) {",
            "  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)",
            "  . ([scriptblock]::Create($fn.Extent.Text))", "}",
            "$RelayConfigFile=$env:DOCTOR_CONFIG", "function Invoke-HttpProbe {throw 'must not access network'}",
            "ConvertTo-Json -InputObject @(Get-RelayDoctorRows) -Compress",
          ].join("\n"));
        } else {
          const source = (await readFile(join(project, "scripts/ops/ops.sh"), "utf8")).replaceAll("\r\n", "\n");
          const fn = (name: string) => {
            const start = source.indexOf(name + "() {\n"), end = source.indexOf("\n}\n", start);
            expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
            return source.slice(start, end + 3);
          };
          await writeFile(runner, ["#!/usr/bin/env bash", "set -eu", "JSON_OUTPUT=1; JSON_ROWS=''; PASS=0; FAIL=0; CHECK_WARN=0",
            'RELAY_CONFIG_FILE="$DOCTOR_CONFIG"', 'curl() { echo "must not access network" >&2; exit 91; }',
            // The jq exit status is a fixture: exercise how doctor reports both validation outcomes.
            'jq() { [ "$DOCTOR_VALID" = 1 ]; }', fn("json_escape"), fn("check"), fn("check_relay"),
            "check_relay", "printf '[%s]\\n' \"$JSON_ROWS\"",
          ].join("\n"));
        }
        // Each non-s3 state empties one required field (provider included); only "s3" is complete.
        for (const state of ["missing", "provider", "endpoint", "region", "bucket", "accessKeyId", "secretAccessKey", "s3"] as const) {
          if (state !== "missing") await writeFile(configPath, JSON.stringify({
            provider: "s3", endpoint: "https://s3.example.test", region: "test", bucket: "bucket", accessKeyId: "do-not-print-ak", secretAccessKey: "do-not-print-secret",
            ...(state === "s3" ? {} : { [state]: "" }),
          }));
          const child = Bun.spawn(shell === "powershell"
            ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner]
            : [bash!, "--noprofile", "--norc", posix(runner)], {
            cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, DOCTOR_CONFIG: shell === "powershell" ? configPath : posix(configPath),
              DOCTOR_SOURCE: join(project, "scripts/ops/ops.ps1"), DOCTOR_VALID: state === "s3" ? "1" : "0" },
          });
          const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          expect(code, out + err).toBe(0);
          expect(out + err).not.toContain("do-not-print");
          const rows = JSON.parse(out) as { Status?: string; status?: string }[];
          expect(rows).toHaveLength(state === "missing" ? 0 : 1);
          if (rows[0]) expect(rows[0].Status ?? rows[0].status).toBe(state === "s3" ? "pass" : "fail");
        }
      } finally { await f.cleanup(); }
    }, 45000);
}
