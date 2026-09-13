export interface InstanceIdentity { instanceId: string; pid: number; port: number; startedAt: number; }
export interface HealthBody { service: "mixin-chatbot"; version: 1; status: "ready" | "stopping"; instanceId: string; pid: number; startedAt: number; }

export function matchesInstance(value: unknown, expected: InstanceIdentity, port: number): value is HealthBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<HealthBody>;
  return body.service === "mixin-chatbot" && body.version === 1 &&
    (body.status === "ready" || body.status === "stopping") &&
    typeof body.instanceId === "string" && /^[a-f0-9-]{36}$/.test(body.instanceId) &&
    Number.isSafeInteger(body.pid) && body.pid! > 0 && Number.isFinite(body.startedAt) && body.startedAt! > 0 &&
    body.instanceId === expected.instanceId && body.pid === expected.pid && body.startedAt === expected.startedAt && expected.port === port;
}
