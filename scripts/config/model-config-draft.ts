import { chmod, copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { MODELS_JSON_PATH, MODELS_STORE_PATH, PI_AGENT_DIR, PI_SETTINGS_PATH } from "../../src/core/storage.ts";
import { archiveFile, replaceFile } from "../../src/core/maintenance.ts";

export interface ModelConfigurationDraft {
  agentDir: string;
  modelsPath: string;
  modelsStorePath: string;
  commit(): Promise<void>;
}

async function copyIfPresent(source: string, target: string): Promise<boolean> {
  try {
    await copyFile(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await chmod(target, 0o600);
  return true;
}

/** 所有交互和 Pi 写入都在草稿内完成；取消不会触碰当前配置或目录缓存。 */
export async function withModelConfigurationDraft(run: (draft: ModelConfigurationDraft) => Promise<void>): Promise<void> {
  await mkdir(PI_AGENT_DIR, { recursive: true });
  const agentDir = await mkdtemp(join(PI_AGENT_DIR, ".configure-"));
  const files = [MODELS_JSON_PATH, PI_SETTINGS_PATH, MODELS_STORE_PATH].map((target) => ({
    target, draft: join(agentDir, basename(target)),
  }));
  try {
    for (const file of files) await copyIfPresent(file.target, file.draft);
    await run({
      agentDir,
      modelsPath: files[0]!.draft,
      modelsStorePath: files[2]!.draft,
      async commit() {
        const id = randomUUID();
        const pending = files.map((file) => ({
          ...file,
          // 在各自目标旁暂存，允许 config 与 runtime 位于不同的 Docker 挂载。
          next: join(dirname(file.target), `.configure-${id}-${basename(file.target)}.next`),
          previous: join(dirname(file.target), `.configure-${id}-${basename(file.target)}.previous`),
          existed: false, published: false,
        }));
        try {
          // 发布前准备好全部新文件和恢复副本，失败恢复时无需重新写入文件内容。
          for (const file of pending) {
            await mkdir(dirname(file.target), { recursive: true });
            if (!await copyIfPresent(file.draft, file.next)) throw new Error(`配置草稿缺少 ${basename(file.target)}`);
            file.existed = await copyIfPresent(file.target, file.previous);
          }
          for (const file of pending) {
            await replaceFile(file.next, file.target);
            file.published = true;
          }
        } catch (error) {
          const failures: unknown[] = [error];
          for (const file of [...pending].reverse()) {
            if (!file.published) continue;
            try {
              if (file.existed) await replaceFile(file.previous, file.target);
              else await archiveFile(file.target);
            } catch (restoreError) { failures.push(restoreError); }
          }
          if (failures.length > 1) throw new AggregateError(failures, "模型配置提交失败，恢复未完成；恢复副本保留在 backup/rm");
          throw error;
        } finally {
          for (const file of pending) {
            await archiveFile(file.next);
            await archiveFile(file.previous);
          }
        }
      },
    });
  } finally {
    await archiveFile(agentDir);
  }
}
