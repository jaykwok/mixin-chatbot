// The service account on macOS: a hidden role account with its own group (not staff, so it reads nothing the operator's
// group may), no shell, no home and no password. Created once by the first deployment and kept afterwards: the data it owns
// stays readable to it across reinstalls. IDs come from 400-480, below the login accounts and clear of Apple's own.
import { accountIdentity, SERVICE_ACCOUNT, type Identity } from "./launchd-host.ts";
import { runCommand, type Runner } from "./hosting.ts";

const DSCL = "/usr/bin/dscl", FIRST_ID = 480, LAST_ID = 400;

async function taken(run: Runner, path: "/Users" | "/Groups", key: "UniqueID" | "PrimaryGroupID"): Promise<Set<number>> {
  const listed = await run([DSCL, ".", "-list", path, key]);
  if (listed.code !== 0) throw new Error(`无法列出 ${path}：${listed.stderr.trim() || listed.code}`);
  return new Set(listed.stdout.split("\n").map(line => Number(line.trim().split(/\s+/).at(-1))).filter(Number.isSafeInteger));
}
async function exists(run: Runner, path: string): Promise<boolean> {
  return (await run([DSCL, ".", "-read", path, "RecordName"])).code === 0;
}

/** The existing account, or a new one with the same free number as UID and GID. A half-created record is removed again. */
export async function ensureServiceAccount(run: Runner = runCommand): Promise<{ identity: Identity; created: boolean }> {
  const existing = await accountIdentity(SERVICE_ACCOUNT, run);
  if (existing) return { identity: existing, created: false };
  const user = `/Users/${SERVICE_ACCOUNT}`, group = `/Groups/${SERVICE_ACCOUNT}`;
  if (await exists(run, user) || await exists(run, group)) throw new Error(`目录服务里已有 ${SERVICE_ACCOUNT} 的不完整记录；请检查后删除（sudo dscl . -delete ${user}、${group}）再部署`);
  const [uids, gids] = [await taken(run, "/Users", "UniqueID"), await taken(run, "/Groups", "PrimaryGroupID")];
  let id = FIRST_ID;
  while (id >= LAST_ID && (uids.has(id) || gids.has(id))) id--;
  if (id < LAST_ID) throw new Error(`${LAST_ID}-${FIRST_ID} 之间没有空闲的 UID/GID，无法创建服务账户`);
  const steps: string[][] = [
    ["-create", group], ["-create", group, "PrimaryGroupID", String(id)], ["-create", group, "RealName", "mixin-bot service"], ["-create", group, "Password", "*"],
    ["-create", user], ["-create", user, "UniqueID", String(id)], ["-create", user, "PrimaryGroupID", String(id)], ["-create", user, "UserShell", "/usr/bin/false"],
    ["-create", user, "NFSHomeDirectory", "/var/empty"], ["-create", user, "RealName", "mixin-bot service"], ["-create", user, "Password", "*"], ["-create", user, "IsHidden", "1"],
  ];
  try {
    for (const step of steps) {
      const result = await run([DSCL, ".", ...step]);
      if (result.code !== 0) throw new Error(`dscl ${step.join(" ")} 失败：${result.stderr.trim() || result.code}`);
    }
    // The directory service's cache may answer for the old state for a moment.
    let identity = await accountIdentity(SERVICE_ACCOUNT, run);
    for (let attempt = 0; !identity && attempt < 20; attempt++) { await Bun.sleep(250); identity = await accountIdentity(SERVICE_ACCOUNT, run); }
    if (!identity || identity.uid !== id || identity.gid !== id) throw new Error("新建的服务账户核对不符");
    return { identity, created: true };
  } catch (error) {
    for (const path of [user, group]) await run([DSCL, ".", "-delete", path]);
    throw error;
  }
}
