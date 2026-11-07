// Opening the login link locally, and the SSH forward hint for hosts reached over SSH.
import { userInfo } from "node:os";

/**
 * Windows and macOS. On Windows the URL goes through an environment variable, never into PowerShell source. On macOS the
 * console runs through sudo: the browser opens in the session of the user who ran it, as that user, not as root.
 */
export async function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let argv: string[];
  if (process.platform === "win32") argv = ["powershell", "-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:MIXIN_CONSOLE_URL"];
  else if (process.platform === "darwin") {
    const uid = env.SUDO_UID && /^\d+$/.test(env.SUDO_UID) ? env.SUDO_UID : "", user = env.SUDO_USER && /^[A-Za-z0-9_.-]+$/.test(env.SUDO_USER) ? env.SUDO_USER : "";
    argv = uid && user ? ["/bin/launchctl", "asuser", uid, "/usr/bin/sudo", "-u", user, "/usr/bin/open", url] : ["/usr/bin/open", url];
  } else throw new Error("只在 Windows 和 macOS 上自动打开浏览器");
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true, env: { ...env, MIXIN_CONSOLE_URL: url } });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(stderr.trim().split(/\r?\n/)[0] || `退出码 ${code}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `ssh -N -L` for the operator's own computer. The host comes from SSH_CONNECTION (the address this SSH session
 * reached) and the user from SUDO_USER or the current login; without SSH_CONNECTION the host stays a placeholder
 * rather than a guess.
 */
export function sshForwardHint(port: number, localPort: number, env: NodeJS.ProcessEnv = process.env): { command: string; guessed: boolean } {
  const server = env.SSH_CONNECTION?.trim().split(/\s+/)[2];
  let user = env.SUDO_USER?.trim() || "";
  if (!user) { try { user = userInfo().username; } catch { user = ""; } }
  return { command: `ssh -N -L 127.0.0.1:${localPort}:127.0.0.1:${port} ${user || "<用户>"}@${server || "<主机>"}`, guessed: !!server };
}
