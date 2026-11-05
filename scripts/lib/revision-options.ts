import type { OptionSpec } from "./maintenance-protocol.ts";

const MACHINE = ["--json", "--shell"];
/** Shared by storage CLI and host orchestration: a typo must never expand a database selection. */
export const REVISION_SPECS: Record<string, OptionSpec> = {
  preview: { flags: MACHINE, values: ["--project"] },
  space: { flags: MACHINE, values: ["--project", "--backup-bytes", "--wal-bytes"], required: ["--backup-bytes", "--wal-bytes"] },
  status: { flags: ["--json"], values: ["--project"] },
  apply: { flags: MACHINE, values: ["--project", "--transaction"] },
  skip: { flags: MACHINE, values: ["--project"] },
  abandon: { flags: MACHINE, values: ["--project"] },
  restore: { flags: MACHINE, values: ["--project", "--space"], required: ["--space"] },
  "shrink-preview": { flags: ["--json"], values: ["--project"], repeat: ["--space"] },
  shrink: { flags: MACHINE, values: ["--project"], repeat: ["--space"] },
  "shrink-status": { flags: ["--json"], values: ["--project"] },
  "shrink-remove-old": { flags: ["--json", "--yes"], values: ["--project"] },
};
