// Shared private directories. Windows PowerShell 5.1 supplies descriptors; policy remains testable TypeScript.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface AclEntry { path: string; owner: string; protected: boolean; rules: { sid: string; type: string }[] }
interface AclSnapshot { currentSid: string; entries: AclEntry[] }
const ADMIN = "S-1-5-32-544", SYSTEM = "S-1-5-18";

const INSPECT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$path = $env:MIXIN_CONSOLE_ACL_PATH
$nativePath = if ($path.StartsWith('\\\\?\\')) { $path } elseif ($path.StartsWith('\\\\')) { '\\\\?\\UNC\\' + $path.Substring(2) } else { '\\\\?\\' + $path }
if (-not [IO.Directory]::Exists($nativePath)) {
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($who in @($sid.Value, 'S-1-5-32-544', 'S-1-5-18') | Select-Object -Unique) {
    $identity = New-Object Security.Principal.SecurityIdentifier($who)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
  }
  [IO.Directory]::CreateDirectory($nativePath, $security) | Out-Null
}
$pending = New-Object 'Collections.Generic.Queue[string]'
$pending.Enqueue($nativePath)
$entries = New-Object 'Collections.Generic.List[object]'
while ($pending.Count -gt 0) {
  $entryPath = $pending.Dequeue()
  # Records are published by link or rename and their temporary files removed while this walks: an entry that is gone
  # is no permission problem. The root itself must exist.
  try {
    $attributes = [IO.File]::GetAttributes($entryPath)
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Console record is a reparse point' }
    $directory = [bool]($attributes -band [IO.FileAttributes]::Directory)
    $item = if ($directory) { [IO.DirectoryInfo]::new($entryPath) } else { [IO.FileInfo]::new($entryPath) }
    $acl = $item.GetAccessControl()
    $children = if ($directory) { @([IO.Directory]::EnumerateFileSystemEntries($entryPath)) } else { @() }
  } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] {
    if ($entryPath -eq $nativePath) { throw }
    continue
  }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString() }
  })
  $display = if ($entryPath.StartsWith('\\\\?\\UNC\\')) { '\\\\' + $entryPath.Substring(8) } else { $entryPath.Substring(4) }
  $entries.Add(@{ path = $display; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected = $acl.AreAccessRulesProtected; rules = $rules })
  foreach ($child in $children) { $pending.Enqueue($child) }
}
@{ currentSid = $sid.Value; entries = @($entries.ToArray()) } | ConvertTo-Json -Depth 6 -Compress
`;

export function assertWindowsAcl(snapshot: AclSnapshot, root: string, recordedSid?: string): void {
  if (!snapshot || !/^S-1-/.test(snapshot.currentSid) || !Array.isArray(snapshot.entries) || !snapshot.entries.length) throw new Error("无法读取控制台权限");
  if (recordedSid !== undefined && recordedSid !== snapshot.currentSid) {
    throw new Error(`.console 的运维身份是 ${recordedSid}，当前账户是 ${snapshot.currentSid}；请换回原账户，不要混用身份`);
  }
  const allowed = new Set([snapshot.currentSid, ADMIN, SYSTEM]);
  let rootFound = false;
  for (const entry of snapshot.entries) {
    const isRoot = resolve(entry.path).toLowerCase() === resolve(root).toLowerCase();
    rootFound ||= isRoot;
    if (![snapshot.currentSid, ADMIN].includes(entry.owner)) throw new Error(`控制台文件属主不符：${entry.path}`);
    if (isRoot && !entry.protected) {
      // Consoles before W2 created .console with the project's inherited ACL; this one never rewrites existing permissions.
      const path = resolve(root);
      throw new Error(`${path} 的权限仍继承上级目录（较早版本的控制台建立的目录会这样），控制台不会自己改动它。二选一：` +
        `确认没有未完成的管理任务后，把这个目录整个移出项目目录，再启动控制台（会新建私有目录，端口和审计记录随旧目录移走）；` +
        `或以当前账户运行 icacls "${path}" /inheritance:r /grant:r "*${snapshot.currentSid}:(OI)(CI)F" "*${ADMIN}:(OI)(CI)F" "*${SYSTEM}:(OI)(CI)F"` +
        ` 收紧为仅当前账户、Administrators 和 SYSTEM，再启动控制台`);
    }
    if (!Array.isArray(entry.rules) || !entry.rules.length || entry.rules.some(rule => !allowed.has(rule.sid) || rule.type !== "Allow")) {
      throw new Error(`控制台文件 DACL 含其他主体或不允许访问：${entry.path}；仅允许当前账户、Administrators、SYSTEM`);
    }
  }
  if (!rootFound) throw new Error("控制台目录的权限记录缺失");
}

/** Does not alter existing permissions. New directories start protected, before their first record is written. */
export function windowsPrivateOwner(dir: string): string {
  const child = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", INSPECT], {
    env: { ...process.env, MIXIN_CONSOLE_ACL_PATH: resolve(dir) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  if (child.exitCode !== 0) throw new Error(`无法检查 .console 的 Windows 权限：${new TextDecoder().decode(child.stderr).trim()}`);
  const snapshot = JSON.parse(new TextDecoder().decode(child.stdout).replace(/^\uFEFF/, "")) as AclSnapshot;
  let recorded: string | undefined;
  try {
    const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
    if (owner?.version !== 1 || typeof owner.sid !== "string") throw new Error(".console/owner.json 格式不支持");
    recorded = owner.sid;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  assertWindowsAcl(snapshot, dir, recorded);
  return snapshot.currentSid;
}
