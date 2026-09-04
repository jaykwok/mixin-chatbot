import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMaterialsIndex,
  loadIgnorePrefixes,
  renderMaterialsIndex,
  resetMaterialsIndexCache,
  scanWorkspace,
} from "../../src/agent/materials-index.ts";

afterEach(() => {
  resetMaterialsIndexCache();
});

async function makeWorkspace(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-index-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "产品资料", "安全大脑"), { recursive: true });
  await mkdir(join(workspace, "案例"), { recursive: true });
  await mkdir(join(workspace, ".venv", "Scripts"), { recursive: true });
  await mkdir(join(workspace, "sync-tools", "rm"), { recursive: true });
  await mkdir(join(root, "index"), { recursive: true });
  await Promise.all([
    writeFile(join(workspace, "产品资料", "安全大脑", "产品介绍.pptx"), "a".repeat(2048)),
    writeFile(join(workspace, "产品资料", "价格清单.xlsx"), "b".repeat(1024)),
    writeFile(join(workspace, "案例", "某项目.docx"), "c".repeat(512)),
    writeFile(join(workspace, ".venv", "Scripts", "python.exe"), "binary"),
    writeFile(join(workspace, "sync-tools", "rm", "已删除.pptx"), "old"),
  ]);
  return { root, workspace };
}

describe("materials index", () => {
  test("collects material files and skips dot directories", async () => {
    const { root, workspace } = await makeWorkspace();
    try {
      const scan = await scanWorkspace(workspace);
      const paths = scan.entries.map((entry) => entry.path);

      expect(paths).toContain("产品资料/安全大脑/产品介绍.pptx");
      expect(paths).toContain("产品资料/价格清单.xlsx");
      expect(paths).toContain("案例/某项目.docx");
      // 虚拟环境等点目录不是资料，进了清单只会稀释检索命中率。
      expect(paths.some((path) => path.startsWith(".venv"))).toBe(false);
      // 路径有序，索引文件的 diff 才稳定。
      expect([...paths].sort()).toEqual(paths);
      expect(scan.truncated).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("honours hand-maintained ignore prefixes", async () => {
    const { root, workspace } = await makeWorkspace();
    const ignorePath = join(root, "index", "ignore.txt");
    await writeFile(
      ignorePath,
      "# 同步盘的回收区，全是已删除文件\r\nsync-tools/rm\r\n\r\n",
      "utf8"
    );

    try {
      const prefixes = await loadIgnorePrefixes(ignorePath);
      expect(prefixes).toEqual(["sync-tools/rm"]);

      const scan = await scanWorkspace(workspace, prefixes);
      const paths = scan.entries.map((entry) => entry.path);
      expect(paths.some((path) => path.startsWith("sync-tools/"))).toBe(false);
      expect(paths).toContain("案例/某项目.docx");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("renders one greppable line per file with size and date", async () => {
    const { root, workspace } = await makeWorkspace();
    try {
      const scan = await scanWorkspace(workspace);
      const rendered = renderMaterialsIndex(workspace, scan, Date.parse("2026-09-04T10:00:00"));

      expect(rendered).toContain("# 本群资料索引");
      expect(rendered).toMatch(
        /产品资料\/安全大脑\/产品介绍\.pptx \| [\d.]+ ?[KMG]?B \| \d{4}-\d{2}-\d{2}/
      );
      expect(rendered).toContain("产品资料/ — 2 个文件");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes the index outside the workspace and reuses it within the TTL", async () => {
    const { root, workspace } = await makeWorkspace();
    const indexPath = join(root, "index", "materials.md");
    const options = {
      workspaceDir: workspace,
      indexPath,
      ignorePath: join(root, "index", "ignore.txt"),
    };

    try {
      const first = await ensureMaterialsIndex(options);
      expect(first?.totalFiles).toBe(4);
      expect(first?.path).toBe(indexPath);
      expect(await readFile(indexPath, "utf8")).toContain("案例/某项目.docx");

      // 新资料同步进来，但仍在 TTL 内：返回缓存摘要，不再阻塞扫描。
      await writeFile(join(workspace, "案例", "新项目.docx"), "d");
      const second = await ensureMaterialsIndex(options);
      expect(second?.totalFiles).toBe(4);
      expect(second?.generatedAt).toBe(first!.generatedAt);

      // TTL 到期后后台刷新，摘要在下一次调用时更新。
      await ensureMaterialsIndex(options, Date.now() + 3600_000);
      await Bun.sleep(50);
      const refreshed = await ensureMaterialsIndex(options);
      expect(refreshed?.totalFiles).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("survives a missing workspace instead of blocking session creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-index-missing-"));
    try {
      const summary = await ensureMaterialsIndex({
        workspaceDir: join(root, "workspace"),
        indexPath: join(root, "nowhere", "materials.md"),
        ignorePath: join(root, "nowhere", "ignore.txt"),
      });
      expect(summary).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
