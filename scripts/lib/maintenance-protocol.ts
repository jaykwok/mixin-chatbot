// The result protocol of the maintenance commands (revision-chain plan §8.5): one result on stdout, everything for people
// on stderr. `--json` writes one line of JSON that starts with protocol, version, command and outcome, in that order;
// `--shell` writes the same as key=value lines for Bash, which has no JSON parser on a Docker host, ending with `end=1`.
// A caller counts a run as successful only with exit status 0 and a complete result of this protocol and version whose
// outcome is `success`; whether the bot may start it decides from the maintenance state read afterwards, never from the
// result alone.
import { MaintenanceRefused } from "../../src/core/maintenance-state.ts";
import { configureLog } from "../../src/core/log.ts";

export const PROTOCOL = "mixin-maintenance";
export const PROTOCOL_VERSION = 1;
export type Outcome = "success" | "refused" | "stopped" | "not-enough-space" | "failed";
export type Mode = "human" | "json" | "shell";

/** Exit statuses kept for people and older callers: the outcome is what callers decide by. */
export const EXIT: Record<Outcome, number> = { success: 0, refused: 1, failed: 1, stopped: 3, "not-enough-space": 4 };

/** Flat fields for `--shell`: numbers, booleans (1/0) and single words only. */
export type ShellFields = Record<string, number | boolean | string>;

function shellValue(key: string, value: number | boolean | string): string {
  const text = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  if (!/^[a-z_]+$/.test(key) || !/^[A-Za-z0-9_.:/-]*$/.test(text)) throw new Error(`协议字段不能用于 --shell：${key}`);
  return `${key}=${text}`;
}

export class Protocol {
  readonly command: string;
  /** `command` is the action as given: anything but a plain action name (an unknown one) is reported as `unknown`. */
  constructor(readonly mode: Mode, command: string) {
    this.command = /^[a-z][a-z-]*$/.test(command) ? command : "unknown";
    // stdout carries only the result in machine mode; log lines of the modules a tool runs go to stderr with the rest.
    if (mode !== "human") configureLog({ stream: "stderr" });
  }

  /** Progress and descriptions: stdout for a person at the terminal, stderr in machine mode. */
  say(line: string): void { if (this.mode === "human") console.log(line); else console.error(line); }

  /**
   * The one result. `text` is what a person reads (stdout in human mode, stderr otherwise); `result` goes into the JSON;
   * `shell` are the flat fields of `--shell`.
   */
  emit(outcome: Outcome, options: { text?: string; message?: string; result?: unknown; shell?: ShellFields } = {}): void {
    if (this.mode === "human") {
      if (options.text) (outcome === "success" ? console.log : console.error)(options.text);
    } else {
      if (options.text) console.error(options.text);
      if (this.mode === "json") {
        console.log(JSON.stringify({ protocol: PROTOCOL, version: PROTOCOL_VERSION, command: this.command, outcome,
          ...(options.message ? { message: options.message } : {}), ...(options.result === undefined ? {} : { result: options.result }) }));
      } else {
        const lines = [`protocol=${PROTOCOL}`, `version=${PROTOCOL_VERSION}`, `command=${this.command}`, `outcome=${outcome}`,
          ...Object.entries(options.shell ?? {}).map(([key, value]) => shellValue(key, value)), "end=1"];
        console.log(lines.join("\n"));
      }
    }
    process.exitCode = EXIT[outcome];
  }

  /** A failure as the protocol's result: `outcome` from the error's class, the message for people and the JSON. */
  fail(error: unknown, outcome: Outcome, prefix: string): void {
    const message = `${prefix}${(error as Error)?.message ?? String(error)}`;
    this.emit(outcome, { text: message, message, ...(error instanceof MaintenanceRefused ? { result: { intent: error.intent, reasons: error.reasons } } : {}) });
  }
}

/** A command line the action does not accept: the outcome is `refused`, nothing was read or changed. */
export class UsageError extends Error {
  override name = "UsageError";
}

/**
 * Strict options: each action takes only the flags and values listed for it; anything else is refused (a mistyped
 * `--spaces` must not turn into "every database"). `repeat` values may be given more than once; `required` ones must be.
 */
export type OptionSpec = { flags?: string[]; values?: string[]; repeat?: string[]; required?: string[] };
export type Parsed = { flags: Set<string>; values: Map<string, string[]> };

export function parseOptions(command: string, args: string[], spec: OptionSpec): Parsed {
  const flags = new Set<string>(), values = new Map<string, string[]>();
  const known = [...spec.flags ?? [], ...spec.values ?? [], ...spec.repeat ?? []];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (spec.flags?.includes(arg)) {
      if (flags.has(arg)) throw new UsageError(`${command}：${arg} 重复`);
      flags.add(arg);
    } else if (spec.values?.includes(arg) || spec.repeat?.includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${command}：${arg} 需要一个值`);
      if (values.has(arg) && !spec.repeat?.includes(arg)) throw new UsageError(`${command}：${arg} 重复`);
      values.set(arg, [...values.get(arg) ?? [], value]);
    } else {
      throw new UsageError(`${command} 不接受参数 ${arg}${known.length ? `（只接受 ${known.join("、")}）` : "（不接受任何参数）"}`);
    }
  }
  if (flags.has("--json") && flags.has("--shell")) throw new UsageError(`${command}：--json 与 --shell 只能选一个`);
  for (const name of spec.required ?? []) if (!values.has(name)) throw new UsageError(`${command} 需要 ${name}`);
  return { flags, values };
}

/** The output mode an action asked for. */
export const modeOf = (parsed: Parsed): Mode => parsed.flags.has("--json") ? "json" : parsed.flags.has("--shell") ? "shell" : "human";
