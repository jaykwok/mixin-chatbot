import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** 默认使用系统临时目录；本机约定通过 TEMP/TMPDIR 和 TEST_TRASH_DIR 注入。 */
export async function tempFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    async cleanup() {
      const trash = process.env.TEST_TRASH_DIR;
      const destination = trash ? join(resolve(trash), `${basename(root)}-${crypto.randomUUID()}`) : undefined;
      try {
        if (trash) await mkdir(resolve(trash), { recursive: true });
        for (let attempt = 0; ; attempt++) {
          try {
            if (destination) await rename(root, destination);
            else await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
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
