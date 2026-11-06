// Home page data: deployment identity, bot status and versions, from the shared host readers.
import type { ConsoleInfo, Overview, ServiceView } from "../ui/src/contract.ts";
import { describeUntil } from "../../ops/lib/age.ts";
import { describeAttention, describeScope, describeScopeState } from "../../ops/tools/directory-admin.ts";
import { probeService, type Service } from "./data.ts";
import { describeMode, loadDeployment, PROJECT_DIR, type Deployment } from "../../ops/core/platform.ts";
import { recoveryReason } from "./recovery.ts";
import { describePendingTransaction, loadPendingTransaction } from "../../ops/core/pending-transaction.ts";
import { versionFacts, versionRows } from "../../ops/tools/version-info.ts";

export function serviceView(service: Service): ServiceView {
  const view: ServiceView = { state: service.state, attention: describeAttention(service.state === "ready" ? service.attention : undefined) };
  if (service.pid !== undefined) view.pid = service.pid;
  if (service.latency !== undefined) view.latency = service.latency;
  if (service.startedAt !== undefined) view.startedAt = service.startedAt;
  if (service.stream) {
    view.stream = { connected: service.stream.connected, reconnects: service.stream.reconnects };
    if (service.stream.disconnectedSince !== undefined) view.stream.disconnectedSince = service.stream.disconnectedSince;
    if (service.stream.lastDisconnect) view.stream.lastDisconnectReason = service.stream.lastDisconnect.reason;
  }
  if (service.directory) {
    const directory = service.directory;
    view.directory = { mappings: directory.mappings, scope: describeScope(directory.scope, service.scopePaths), state: directory.state,
      stateText: describeScopeState(directory, service.scopePaths) };
    if (directory.lastCompleteAt !== undefined) view.directory.lastCompleteAt = directory.lastCompleteAt;
    if (directory.running) view.directory.running = `${directory.running.mode === "apply" ? "应用新范围" : "日常同步"}：${directory.running.phase}`;
    if (directory.failure && directory.state === "effective")
      view.directory.failure = directory.failure + (directory.retryAt ? `（${describeUntil(directory.retryAt)}自动重试）` : "");
    if (directory.recheck) view.directory.recheck = `${directory.recheck.count} 名成员缺席，${describeUntil(directory.recheck.at)}复核，仍缺席的才撤销`;
  }
  return view;
}

/** `info.build` is the build the console started from; reading Git again here would block the server. */
export async function loadOverview(info: ConsoleInfo): Promise<Overview> {
  let deployment: Deployment | null = null, deploymentError: string | null = null;
  try { deployment = loadDeployment(); }
  catch (error) { deploymentError = (error as Error).message; }

  let pending: Overview["pending"] = null;
  try {
    const transaction = loadPendingTransaction(PROJECT_DIR);
    if (transaction) pending = describePendingTransaction(transaction);
  } catch { /* recoveryReason explains an unreadable record */ }

  const service: Service = deployment ? await probeService(deployment.port) : { state: "unreachable" };
  const facts = versionFacts(PROJECT_DIR, service.program, info.build);
  return {
    checkedAt: Date.now(),
    console: info,
    deployment: deployment && { platform: deployment.platform, runtime: deployment.runtime, mode: describeMode(deployment),
      port: deployment.port, dataRoot: deployment.dataRoot, workspaceRoot: deployment.workspaceRoot },
    deploymentError,
    recovery: recoveryReason(),
    pending,
    service: serviceView(service),
    versions: versionRows(facts),
  };
}
