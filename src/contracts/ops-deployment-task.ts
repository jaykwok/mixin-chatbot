/** A deployment transaction's data step: the transaction it belongs to (its snapshot name) and the operation log it appends to. */
export interface OpsDeploymentTask { id: string; log?: string }
const OPERATION_LOG = /^(upgrade|deploy|startup)-[\dTZ]+-[\w-]+\.log$/;
export function validOpsDeploymentTask(value: unknown): value is OpsDeploymentTask {
  const v = value as OpsDeploymentTask;
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(key => key === "id" || key === "log")
    && typeof v.id === "string" && /^deploy-[A-Za-z0-9]+$/.test(v.id) && (v.log === undefined || typeof v.log === "string" && OPERATION_LOG.test(v.log));
}
/** The caller's operation log (ops.sh operation_start), when its name is one a data tool may append to. */
export const inheritedOperationLog = (value = process.env.BOT_OPERATION_LOG) => value && OPERATION_LOG.test(value) ? value : undefined;
