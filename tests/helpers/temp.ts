import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { move } from "fs-extra";
import { isPathInside } from "../../src/agent/paths.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = resolve(process.env.TEST_TEMP_ROOT ?? join(project, "backup/tmp/test-fixtures"));
const archive = resolve(process.env.TEST_TRASH_DIR ?? join(project, "backup/rm"));
mkdirSync(fixtures, { recursive: true });
export function testTempDir(): string { return fixtures; }

export async function archiveFixture(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
  const source = resolve(path);
  if (source === fixtures || !isPathInside(source, fixtures)) throw new Error("Fixture archive outside test root: " + source);
  try {
    if (!isPathInside(await realpath(dirname(source)), await realpath(fixtures))) throw new Error("Fixture parent escapes test root");
    await mkdir(archive, { recursive: true });
    await move(source, join(archive, `${basename(source)}-${crypto.randomUUID()}`), { overwrite: false });
  } catch (error) { if (options?.force && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

/** Tests use only backup/tmp and archive fixtures under backup/rm. */
export async function tempFixture(prefix: string) {
  const root = await mkdtemp(join(fixtures, prefix));
  return {
    root,
    async cleanup() {
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await archiveFixture(root, { force: true });
            return;
          } catch (error) {
            if (!["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt === 4) throw error;
            await Bun.sleep(50);
          }
        }
      } catch (error) {
        // 清理失败保留现场并给出路径，不能覆盖测试本身的断言/异常。
        console.warn(`测试目录清理失败，保留 ${root}: ${String(error)}`);
      }
    },
  };
}
