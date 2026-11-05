export type OpsNetwork = "none" | "bridge" | "host" | `container:${string}`;
export function validOpsNetwork(value: unknown): value is OpsNetwork {
  return typeof value === "string" && (["none", "bridge", "host"].includes(value) || /^container:[a-f0-9]{64}$/.test(value));
}
