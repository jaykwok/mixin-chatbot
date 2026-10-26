// Version facts for operators: what is actually running (or last deployed), next to the local tool's own version.
// The running program names itself in /health (appVersion, build); the deployment record names what the last
// committed deployment installed. A newer checkout never stands in for either. Built-ins only, no credentials.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMetadata, VERSION_FILE } from "../../src/core/data-version.ts";
import { matchesInstance } from "../../src/core/health.ts";
import { APP_BUILD } from "../../src/core/version.ts";

export interface ProgramVersion { appVersion: string; build: string }
export interface VersionFacts {
  /** running: from the service's /health; deployed: from the deployment record while no service answers; none: neither. */
  source: "running" | "deployed" | "none";
  program?: ProgramVersion;
  /** Data format of the deployment record. */
  dataVersion?: number;
  /** The record could not be read; the text says why. */
  recordError?: string;
  /** This checkout (or image), which ops commands run. */
  local: ProgramVersion;
}

/** The checkout's version and build, read now: a long-running TUI must not report the code it was started from. */
export function localProgram(project: string, build?: string): ProgramVersion {
  let appVersion = "";
  try { appVersion = String(JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version ?? ""); } catch { /* shown as unknown */ }
  return { appVersion, build: (build ?? checkoutBuild(project)) || APP_BUILD };
}

/** Same rule as the image build and the Windows launcher: 12 commit characters, `-dirty` with tracked changes. */
function checkoutBuild(project: string): string {
  const git = (...args: string[]) => spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 10_000, env: { ...process.env, LC_ALL: "C" } });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0 || !/^[0-9a-f]{12,}$/.test(head.stdout.trim())) return "";
  const status = git("status", "--porcelain", "--untracked-files=no");
  return head.stdout.trim().slice(0, 12) + (status.status === 0 && status.stdout.trim() ? "-dirty" : "");
}

/** The program a /health body names, when it is the new protocol (older bodies carry no appVersion). */
export function healthProgram(body: unknown): ProgramVersion | undefined {
  const value = body as { appVersion?: unknown; build?: unknown } | null;
  return value && typeof value.appVersion === "string" && value.appVersion
    ? { appVersion: value.appVersion, build: typeof value.build === "string" ? value.build : "" } : undefined;
}

/**
 * `running` is the program of a service that passed the instance check (see probeService / health-check.ts);
 * `localBuild` the checkout build when the caller already read Git (no second Git process).
 */
export function versionFacts(project: string, running?: ProgramVersion, localBuild?: string): VersionFacts {
  const facts: VersionFacts = { source: "none", local: localProgram(project, localBuild) };
  try {
    const record = readMetadata(join(project, "data", "state", VERSION_FILE)) as Record<string, unknown> | null;
    if (record !== null) {
      if (typeof record !== "object" || !Number.isSafeInteger(record.dataVersion)) throw new Error("部署记录损坏");
      facts.dataVersion = record.dataVersion as number;
      if (typeof record.appVersion === "string" && record.appVersion) {
        facts.source = "deployed";
        facts.program = { appVersion: record.appVersion, build: typeof record.build === "string" ? record.build : "" };
      } else facts.recordError = "部署记录没有程序版本（旧版数据）";
    }
  } catch (error) { facts.recordError = (error as Error).message; }
  if (running) { facts.source = "running"; facts.program = running; }
  return facts;
}

/** Short build for display: 7 commit characters, keeping `-dirty`. */
export function shortBuild(build: string): string {
  return build ? build.replace(/^([0-9a-f]{7})[0-9a-f]*/, "$1") : "";
}

function differs(local: ProgramVersion, other: ProgramVersion): boolean {
  return local.appVersion !== other.appVersion || (!!local.build && !!other.build && local.build !== other.build);
}

function label(program: ProgramVersion, withBuild: boolean): string {
  return `v${program.appVersion}${withBuild && program.build ? ` 构建 ${shortBuild(program.build)}` : ""}`;
}

/**
 * Display rows: 应用机器人 / 构建 / 数据格式, plus 本地工具 when the local tool is not what runs (or was deployed).
 * The program row says whether the version comes from the running service or only from the deployment record.
 */
export function versionRows(facts: VersionFacts): [string, string][] {
  const rows: [string, string][] = [];
  const program = facts.program;
  if (program) {
    rows.push(["应用机器人", `v${program.appVersion}${facts.source === "deployed" ? "（未运行，取自部署记录）" : ""}`]);
    rows.push(["构建", shortBuild(program.build) || "—"]);
  } else rows.push(["应用机器人", facts.recordError ? `未知：${facts.recordError}` : "尚未部署"]);
  rows.push(["数据格式", facts.dataVersion === undefined ? "—" : String(facts.dataVersion)]);
  if (program && facts.local.appVersion && differs(facts.local, program)) {
    const withBuild = facts.local.appVersion === program.appVersion;
    rows.push(["本地工具", `${label(facts.local, withBuild)} · ${facts.source === "running" ? "运行服务" : "已部署"} ${label(program, withBuild)}`]);
  }
  return rows;
}

/** The program of this checkout's ready service on `port`, checked against data/state/instance.json like the health check. */
async function probeProgram(project: string, port: number): Promise<ProgramVersion | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500), redirect: "error" });
    const body: unknown = await response.json();
    const expected = JSON.parse(readFileSync(join(project, "data", "state", "instance.json"), "utf8"));
    return response.ok && matchesInstance(body, expected, port) ? healthProgram(body) : undefined;
  } catch { return undefined; }
}

if (import.meta.main) {
  // ops doctor: one tab-separated row per line. The running program comes from the /health body on stdin (ops.sh, which
  // may run this inside the container) or from this checkout's service on --port (ops.ps1).
  let running: ProgramVersion | undefined;
  const port = process.argv.indexOf("--port");
  if (process.argv.includes("--health-stdin")) {
    try { running = healthProgram(JSON.parse(await Bun.stdin.text())); } catch { running = undefined; }
  } else if (port > 0) running = await probeProgram(process.cwd(), Number(process.argv[port + 1]));
  for (const [name, value] of versionRows(versionFacts(process.cwd(), running))) console.log(`${name}\t${value}`);
}
