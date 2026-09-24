import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { bytes, ordinaryPath, publish, publishJson } from "./io.ts";
import type { Context, Migration, Preview, PreviewContext } from "./types.ts";

export function previewContext(context: Context): PreviewContext {
  const path = async (name: string) => {
    const target = resolve(context.groups, name);
    await ordinaryPath(context.groups, target);
    return target;
  };
  return { project: context.project, decisions: context.decisions, groups: Object.freeze({
    read: async (name: string) => bytes(await path(name)),
    directories: async (name: string) => {
      const entries = await readdir(await path(name), { withFileTypes: true });
      if (entries.some(entry => entry.isSymbolicLink())) throw new Error("群数据含符号链接，请人工检查");
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    },
  }) };
}

/** Only preview callbacks run here. They receive a private project and a read-only group capability. */
export async function describeMigrations(context: Context, steps: Migration[], configs: string[], validate?: (staging: string) => Promise<void>) {
  const temporaryRoot = join(context.project, "data/runtime/tmp");
  await ordinaryPath(context.project, temporaryRoot);
  await mkdir(temporaryRoot, { recursive: true });
  const staging = await mkdtemp(join(temporaryRoot, "migration-preview-"));
  const descriptions: Preview[] = [], files: string[] = [];
  try {
    for (const path of configs) {
      const content = await bytes(path);
      if (content !== null) await publish(join(staging, relative(context.project, path)), content);
    }
    const preview = { ...previewContext(context), project: staging };
    for (const step of steps) {
      const description = await step.preview(preview);
      descriptions.push(description);
      for (const file of description.files) {
        if (!["project", "groups"].includes(file.root)) throw new Error("迁移文件声明无效");
        const root = context[file.root], target = resolve(root, file.path);
        await ordinaryPath(root, target);
        files.push(target);
      }
      for (const [path, value] of Object.entries(description.configuration ?? {})) {
        const original = resolve(context.project, path);
        if (!configs.includes(original)) throw new Error("预览只能投影声明的项目配置");
        // Resolve through the checked relative path: an absolute path must never bypass staging.
        const target = resolve(staging, relative(context.project, original));
        await ordinaryPath(staging, target);
        await publishJson(target, value);
      }
    }
    if (!descriptions.some(description => description.decisions.length)) await validate?.(staging);
    return { descriptions, files };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
