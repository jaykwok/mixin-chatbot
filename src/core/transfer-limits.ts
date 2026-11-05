// Protocol limits shared by runtime requests and side-effect-free configuration validation.
/** Outbound only: at most this many bytes go as a native platform file (measured 2026-10-23: 30 MiB passes, one byte more is refused at upload init); larger files use the relay. */
export const NATIVE_FILE_MAX_BYTES = 30 * 1024 * 1024;
/** One relay delivery's whole budget (snapshot, waiting for the lock, probes and the PUT); the run and /stop cancel it as well. */
export const RELAY_HTTP_TIMEOUT = 30 * 60_000;
export const RELAY_PROBE_TIMEOUT = 15_000;
