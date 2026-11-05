// The host runtime bootstrap (scripts/lib/ops-runtime.sh) picks the pinned Bun build for the host's architecture, and
// refuses a host the host core cannot run on before anything is downloaded.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const library = fileURLToPath(new URL("../../scripts/lib/ops-runtime.sh", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

/** `ops_bun_asset` on a Linux host whose `uname -m` says `arch` and whose `ldd --version` says `libc`. */
async function asset(arch: string, libc: string) {
  const script = `. "$1"; uname() { if [ "$1" = -s ]; then echo Linux; else echo "$HOST_ARCH"; fi; }; ldd() { printf '%s\\n' "$HOST_LIBC"; }; ops_bun_asset`;
  const child = Bun.spawn([bash!, "-c", script, "ops-runtime", posix(library)], { env: { ...process.env, HOST_ARCH: arch, HOST_LIBC: libc },
    stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test.skipIf(!bash)("the pinned Bun follows the architecture of a glibc host; a musl host is refused before any download", async () => {
  expect(await asset("x86_64", "ldd (Ubuntu GLIBC 2.39-0ubuntu8.6) 2.39")).toEqual({ code: 0, stderr: "",
    stdout: "bun-linux-x64-baseline e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76\n" });
  expect(await asset("aarch64", "ldd (GNU libc) 2.41")).toEqual({ code: 0, stderr: "",
    stdout: "bun-linux-aarch64 baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e\n" });
  for (const arch of ["x86_64", "aarch64"]) {
    expect(await asset(arch, "musl libc (x86_64)\nVersion 1.2.5")).toEqual({ code: 1, stdout: "", stderr: "不支持 Alpine/musl 主机（宿主侧核心需要 glibc），未下载运行时\n" });
  }
  expect(await asset("x86_64", "ldd: unrecognized option")).toEqual({ code: 1, stdout: "", stderr: "无法确定宿主 libc，未下载运行时\n" });
  expect(await asset("riscv64", "ldd (GNU libc) 2.41")).toEqual({ code: 1, stdout: "", stderr: "不支持的 Linux 架构：riscv64\n" });
}, 30_000);
