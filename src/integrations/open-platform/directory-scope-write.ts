// Keep writes separate: the host console bundles the read/schema module without installed robot dependencies.
import { publish } from "../../lib/atomic-file.ts";
import { DIRECTORY_CONFIG_PATH } from "../../core/storage.ts";
import { scopeFileText, type DirectoryScope } from "./directory-scope.ts";

/** 保存范围（同目录临时文件，落盘后替换）。0644：部署计划和正式文件可能由另一身份读取。 */
export async function writeDirectoryScope(scope: DirectoryScope, path = DIRECTORY_CONFIG_PATH): Promise<void> {
  await publish(path, scopeFileText(scope), { mode: 0o644 });
}
