import { spawn } from "node:child_process";
const [mode, output] = process.argv.slice(2);
const stage = (phase: string, state = "end", code?: number) => console.error("migration-validation " + JSON.stringify({ id: process.env.MIXIN_VALIDATION_ID, phase, state, code, pid: process.pid }));
if (mode === "entry-delay") { await Bun.sleep(30_000); }
stage("entry-ready"); stage("imports-start", "start"); stage("imports-ready");
if (mode === "block") { stage("config", "start"); setInterval(() => {}, 1000); }
else if (mode === "pipe") {
  const child = spawn(process.execPath, ["-e", "console.log('DESCENDANT:'+process.pid); process.send?.('ready'); setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });
  child.once("message", () => { stage("result", "end", 0); process.exit(0); });
} else if (mode === "signal") process.kill(process.pid, "SIGTERM");
else if (mode === "exit143") process.exit(143);
else { stage("config", "start"); stage("config", mode === "invalid" ? "failed" : "end"); stage("result", mode === "invalid" ? "failed" : "end", mode === "invalid" ? 1 : 0); process.exitCode = mode === "invalid" ? 1 : 0; }
void output;
