import { join } from "node:path";
import type { ReadPage } from "../ui/src/contract.ts";
import { redactSecrets } from "../../src/lib/redact.ts";
import { capture } from "./query.ts";
import { hostPlatform, opsCommand, SOURCE_DIR } from "../../ops/core/platform.ts";
import type { AuditLog } from "./audit.ts";
import { ApiProblem } from "./routes.ts";
import type { Route } from "./routes.ts";
import { READ_PAGES } from "./read-pages.ts";
import type { Health } from "./data.ts";

export function readRoutes(project: string, audit: AuditLog, query = capture): Record<string, Route> {
  return Object.fromEntries([...READ_PAGES, "health"].map(page => [`POST /api/read/${page}`, {
    slow: true,
    run: async ({ body, session, signal }) => {
      const args = body as Record<string, unknown> | null;
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !["keyword", "level", "task", "export"].includes(key))
        || ["keyword", "task", "level"].some(key => args[key] !== undefined && (typeof args[key] !== "string" || (args[key] as string).length > 128))
        || (args.export !== undefined && typeof args.export !== "boolean")) throw new ApiProblem(400, "input", "筛选参数无效");
      if (page === "logs") audit.write({ action: args.export ? "log-export" : "log-view", session: session.label, scope: "logs", mode: "default" });
      const { command, args: argv, env } = page === "health" ? opsCommand(hostPlatform(), ["doctor", "--json"], project, SOURCE_DIR, "console")
        : { command: process.execPath, args: ["--no-env-file", join(SOURCE_DIR, "console/server/read-cli.ts"), "--project", project, "--page", page,
          "--filters", Buffer.from(JSON.stringify({ keyword: args.keyword, level: args.level, task: args.task })).toString("base64")], env: {} };
      const result = await query(command, argv, { env, signal, timeout: 90_000 });
      if (result.timedOut) throw new ApiProblem(504, "timeout", "读取超时，请稍后重试");
      // Doctor's exit 1 reports failed checks. Accept it only with the complete, internally consistent diagnostic protocol.
      if (result.code !== 0 && !(page === "health" && result.code === 1)) throw new ApiProblem(503, "internal", "读取失败，请检查部署状态、配置格式和权限");
      let value: unknown;
      try { value = JSON.parse(result.stdout); } catch { throw new ApiProblem(502, "internal", page === "health" ? "体检结果不完整" : "读取结果不完整"); }
      if (page !== "health") return value;
      const health = value as Health | null;
      if (!health || !Array.isArray(health.checks) || !health.checks.every(row => row && typeof row.name === "string"
        && ["pass", "warn", "fail"].includes(row.status) && typeof row.detail === "string" && typeof row.fix === "string")
        || !(["pass", "warn", "fail"] as const).every(status => Number.isSafeInteger(health[status])
          && health[status] === health.checks.filter(row => row.status === status).length)
        || result.code !== (health.fail > 0 ? 1 : 0)) throw new ApiProblem(502, "internal", "体检结果不完整");
      const clean = (s: string) => redactSecrets(String(s)).replace(/\b1[3-9]\d{9}\b/g, value => `${value.slice(0, 3)}****${value.slice(-4)}`);
      const labels = { pass: "通过", warn: "警告", fail: "失败" };
      return { checkedAt: Date.now(), columns: ["检查", "结果", "说明", "处理建议"],
        rows: health.checks.map(row => [clean(row.name), labels[row.status], clean(row.detail), clean(row.fix)]),
        note: `${health.pass} 项通过，${health.warn} 项警告，${health.fail} 项失败。体检不会修改配置。` } satisfies ReadPage;
    },
  } satisfies Route]));
}
