// Synthetic operation for testing the executor's pipes and result protocol, never imports real ops or configuration.
const mode = process.argv[2];
for (let i = 0; i < 160; i++) console.error(`中文诊断 ${i} token=do-not-persist-${i} ${"x".repeat(1024)}`);
console.error("部署阶段：forward/stop");
console.log("阶段完成，手机号 13800138000");
if (mode === "slow") await Bun.sleep(6500);
if (mode !== "missing") {
  await Bun.write(process.env.MIXIN_OPS_RESULT_FILE!, JSON.stringify({ protocol: "mixin-ops", version: 1,
    command: "stop", wasRunning: false, finalState: "stopped", exitCode: 0, outcome: "success", message: "合成操作完成" }));
}
process.exitCode = mode === "contradictory" ? 3 : 0;
