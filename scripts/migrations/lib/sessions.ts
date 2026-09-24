import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { info } from "./io.ts";

/** Validate the legacy/current Pi JSONL envelope; never rewrite conversation history. */
export async function validateSessions(root: string): Promise<void> {
  async function directories(path: string) {
    const stat = await info(path);
    if (!stat) return [];
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("群或成员目录格式无法识别");
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some(entry => entry.isSymbolicLink())) throw new Error("群或成员目录含符号链接，请人工检查");
    return entries.filter(entry => entry.isDirectory()).map(entry => join(path, entry.name));
  }
  for (const group of await directories(root)) for (const user of await directories(join(group, "users"))) {
    const path = join(user, "session.jsonl"), stat = await info(path);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("会话不是普通文件");
    const input = createReadStream(path, { encoding: "utf8" });
    let first = true;
    try {
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { throw new Error("会话含损坏的 JSONL 记录，请人工修复后继续迁移"); }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("会话记录格式无法识别");
        if (first && (entry.type !== "session" || ![1, 2, 3].includes(entry.version ?? 1) || typeof entry.id !== "string")) throw new Error("会话头格式无法识别");
        first = false;
      }
      if (first) throw new Error("会话头缺失");
    } finally { input.destroy(); }
  }
}
