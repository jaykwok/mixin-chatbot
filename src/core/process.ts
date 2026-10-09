import { application } from "./lifecycle.ts";
import { executeProcess, type ProcessOptions } from "../../scripts/lib/process.ts";

export type { ProcessOptions } from "../../scripts/lib/process.ts";

/** Service lifecycle adapter; migrations and tests use the same executor without the application singleton. */
export function runProcess(options: ProcessOptions) {
  const signal = AbortSignal.any([application.signal, ...(options.signal ? [options.signal] : [])]);
  return application.track(executeProcess({ ...options, signal }));
}
