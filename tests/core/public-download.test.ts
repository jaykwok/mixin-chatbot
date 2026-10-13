import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { downloadPublicBytes, isPublicAddress } from "../../src/core/public-download.ts";
import { tempFixture } from "../helpers/temp.ts";

test("attachment policy accepts global addresses and rejects non-public and transition ranges", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.215.14", "2606:4700:4700::1111", "2001:4860:4860::8888"]) expect(isPublicAddress(address), address).toBe(true);
  for (const address of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1",
    "192.168.1.1", "192.0.0.9", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fe80::1", "fe80::1%eth0", "fc00::1", "ff02::1",
    "64:ff9b::a00:1", "2001::1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "invalid"]) expect(isPublicAddress(address), address).toBe(false);
});

test("normalized numeric URLs and credentials cannot bypass the policy", async () => {
  for (const url of ["http://2130706433/", "http://0x7f000001/", "http://127.1/", "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/latest/meta-data", "https://user:secret@1.1.1.1/", "file:///etc/passwd"]) {
    await expect(downloadPublicBytes(url, 1024, AbortSignal.timeout(1000)), url).rejects.toThrow();
  }
});

test("public downloads pin DNS and enforce redirects, peer, size and cancellation", async () => {
  const fixture = await tempFixture("public-download-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/public-download.ts", import.meta.url))], {
    cwd: fixture.root, env: process.env, stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0); expect(out).toContain("PUBLIC_DOWNLOAD_PASSED");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 20000);
