import { cliArgs } from "./cli.ts";
export const BACKUP_OPTIONS = { confirm: { type: "string" } } as const;
export function backupOptions(args: string[]) {
  const { values, positionals } = cliArgs(args, BACKUP_OPTIONS);
  const [command = "scan", report, ...extra] = positionals;
  if (extra.length || !["scan", "apply", "help"].includes(command)) throw new Error("备份清理动作或参数无效");
  if (command !== "apply") {
    if (report !== undefined || values.confirm !== undefined) throw new Error(`${command} 不接受其他参数`);
  } else if (!report || !/^\d{8}T\d{6}Z-[a-f0-9]{6}$/.test(report)) throw new Error("需要有效报告名（tmp/backup-cleanup 下的目录名）");
  if (values.confirm !== undefined && !/^[a-f0-9]{16}$/.test(values.confirm)) throw new Error("确认码必须是预演给出的 16 位十六进制字符串");
  return { command, report, confirm: values.confirm, normalized: [command, ...(report ? [report] : []), ...(values.confirm ? ["--confirm", values.confirm] : [])] };
}
