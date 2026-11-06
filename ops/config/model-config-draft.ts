import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { MODELS_JSON_PATH, MODELS_STORE_PATH, PI_AGENT_DIR, PI_SETTINGS_PATH } from "../../src/core/storage.ts";
import { archiveFile, replaceFile } from "../../src/core/maintenance.ts";
import { publish } from "../../src/lib/atomic-file.ts";
import { configurationSnapshot } from "./configuration-form.ts";
import { serializeConfigurationStage, stageName } from "./configuration-stage.ts";

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
        let unrestored = false;
        try {
          // 发布前准备好全部新文件和恢复副本，失败恢复时无需重新写入文件内容。
          for (const file of pending) {
            await mkdir(dirname(file.target), { recursive: true });
            // Durable before the first replacement, like every other configuration writer (publish: fsync, 0600).
            const next = await readIfPresent(file.draft);
            if (next === null) throw new Error(`配置草稿缺少 ${basename(file.target)}`);
            await publish(file.next, next, { createOnly: true });
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
              else await rm(file.target, { force: true });
            } catch (restoreError) { failures.push(restoreError); }
          }
          if (failures.length > 1) {
            unrestored = true;
            throw new AggregateError(failures, "模型配置提交失败，恢复未完成；恢复副本保留在 backup/rm");
          }
          throw error;
        } finally {
          // 副本里有服务商凭据：只有恢复没完成时把恢复副本归档到 backup/rm，其余一律删除。
          for (const file of pending) {
            await rm(file.next, { force: true });
            if (unrestored) await archiveFile(file.previous);
            else await rm(file.previous, { force: true });
          }
        }
      },
    });
  } finally {
    // 草稿也是凭据的副本，结束时删除，不归档。
    await rm(agentDir, { recursive: true, force: true });
  }
}

const readIfPresent = (path: string) => readFile(path, "utf8").catch(error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
});

/**
 * 部署停机前的草稿：服务仍在运行，不取维护租约，不改项目文件。现有的三个文件取自项目（受限读取）作为暂存的基准，
 * 写进暂存目录里的草稿；交互和 Pi 写入都在草稿内完成，commit 把结果写成暂存目录的 configuration-models.json（0600），
 * 停止服务后由部署安装。
 */
export async function withStagedModelConfiguration(project: string, stage: string, run: (draft: ModelConfigurationDraft) => Promise<void>): Promise<void> {
  const base = configurationSnapshot(project, "models");
  const agentDir = await mkdtemp(join(stage, ".configure-"));
  const paths = { models: join(agentDir, basename(MODELS_JSON_PATH)), settings: join(agentDir, basename(PI_SETTINGS_PATH)),
    catalog: join(agentDir, basename(MODELS_STORE_PATH)) };
  try {
    for (const key of ["models", "settings", "catalog"] as const) {
      const text = base.files[key];
      if (text != null) await writeFile(paths[key], text, { mode: 0o600, flag: "wx" });
    }
    await run({
      agentDir, modelsPath: paths.models, modelsStorePath: paths.catalog,
      async commit() {
        const files = { models: await readIfPresent(paths.models), settings: await readIfPresent(paths.settings), catalog: await readIfPresent(paths.catalog) };
        if (files.models === null || files.settings === null) throw new Error("配置草稿缺少 models.json 或 settings.json");
        await publish(join(stage, stageName("models")), serializeConfigurationStage({ version: 1, base,
          next: { kind: "models", binding: base.binding, files } }), { createOnly: true });
      },
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}
