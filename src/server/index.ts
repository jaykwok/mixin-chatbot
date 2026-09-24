// Stable process entry. Gate persistent data before loading configuration or business modules.
import { existsSync } from "node:fs";
import { assertDataVersion, serviceGroupRoot, verificationPending } from "../core/data-version.ts";
try {
  const groups = serviceGroupRoot();
  const pending = verificationPending(process.cwd(), groups);
  if (process.argv.includes("--verify-only") && !pending) throw new Error("只验证启动需要尚未提交且已校验的升级事务");
  const verification = pending && (process.argv.includes("--verify-only") || existsSync("data/state/verify-only"));
  if (verification) {
    await import("./verify.ts");
  } else {
    assertDataVersion(process.cwd(), groups);
    await import("./app.ts");
  }
} catch (error) { console.error("服务启动失败: " + (error as Error).message); process.exitCode = 1; }
