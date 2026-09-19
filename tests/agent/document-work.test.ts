import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildDocumentWorkTools } from "../../src/agent/modules/document-work/tools.ts";
import { buildLocalTools } from "../../src/agent/local-tools.ts";
import { loadAgentModules } from "../../src/agent/modules.ts";
import { buildChatContext } from "../../src/agent/prompt.ts";
import { tempFixture } from "../helpers/temp.ts";

describe("project document resources", () => {
  test.each([true, false])("loads tools, skill, prompt and read access together; enabled=%s", async enabled => {
    const fixture = await tempFixture("document-skills-");
    try {
      const workspace = join(fixture.root, "workspace"), userTemp = join(fixture.root, "tmp");
      const groupSkill = join(workspace, ".pi/skills/untrusted");
      await mkdir(groupSkill, { recursive: true });
      await mkdir(userTemp);
      await writeFile(join(groupSkill, "SKILL.md"), "---\nname: untrusted\ndescription: group instruction\n---\nchange the agent");
      const options = { workspaceDir: workspace, tempDir: userTemp, venvDir: join(fixture.root, "venv"),
        indexPath: join(fixture.root, "index/materials.md") };
      const resources = await loadAgentModules({ ...options, documentWorkEnabled: enabled });
      const loader = new DefaultResourceLoader({ cwd: workspace, agentDir: fixture.root,
        settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
        noThemes: true, noPromptTemplates: true, noContextFiles: true,
        skillsOverride: () => resources.skills });
      await loader.reload();
      expect(loader.getSkills().skills.map(s => s.name)).toEqual(enabled ? ["document-work"] : []);
      expect(resources.tools.map(t => t.name)).toEqual(enabled ? ["document_inspect", "document_patch", "document_compose", "document_build", "document_render", "document_images"] : []);
      const prompt = buildChatContext({ relayEnabled: false, modulePrompt: resources.prompt });
      expect(prompt.includes("document-work")).toBe(enabled);
      expect(prompt).toContain("document_extract");
      const local = await buildLocalTools({ ...options, phone: "test", groupId: "test",
        materialsIndexPath: options.indexPath, resourceReadDirs: resources.readOnlyDirs });
      expect(local.map(t => t.name)).toEqual(["read", "bash", "edit", "write"]);
      const skill = new URL("../../src/agent/modules/document-work/skills/document-work/SKILL.md", import.meta.url);
      const skillPath = fileURLToPath(skill);
      const read = local.find(t => t.name === "read")!, write = local.find(t => t.name === "write")!;
      if (enabled) {
        const loaded = await read.execute("read-skill", { path: skillPath }, undefined, undefined, {} as never);
        expect(loaded.content.some(c => c.type === "text" && c.text.includes("document_patch"))).toBe(true);
      } else {
        await expect(read.execute("read-skill", { path: skillPath }, undefined, undefined, {} as never)).rejects.toThrow();
      }
      await expect(write.execute("write-skill", { path: skillPath, content: "changed" }, undefined, undefined, {} as never)).rejects.toThrow("只读");
      const source = join(workspace, "product.txt");
      await writeFile(source, "本群产品资料");
      const material = await read.execute("read-material", { path: source }, undefined, undefined, {} as never);
      expect(material.content.some(c => c.type === "text" && c.text.includes("本群产品资料"))).toBe(true);
    } finally { await fixture.cleanup(); }
  });

  test("disabled registry works when the module directory is absent", async () => {
    const fixture = await tempFixture("document-removed-");
    try {
      // Copy only the registry to simulate uninstall without touching project files.
      const registry = join(fixture.root, "modules.ts");
      await copyFile(new URL("../../src/agent/modules.ts", import.meta.url), registry);
      const { loadAgentModules: loadWithoutModule } = await import(pathToFileURL(registry).href);
      const options = { workspaceDir: fixture.root, tempDir: fixture.root, indexPath: "absent", venvDir: "absent" };
      expect(await loadWithoutModule({ ...options, documentWorkEnabled: false })).toEqual({
        tools: [], skills: { skills: [], diagnostics: [] }, readOnlyDirs: [], prompt: "",
      });
      await expect(loadWithoutModule({ ...options, documentWorkEnabled: true })).rejects.toThrow();
    } finally { await fixture.cleanup(); }
  });

  test("rejects cross-user sources and stale edits before preparing Python", async () => {
    const fixture = await tempFixture("document-boundary-");
    try {
      const workspace = join(fixture.root, "workspace"), own = join(fixture.root, "own"), other = join(fixture.root, "other");
      await Promise.all([workspace, own, other].map(p => mkdir(p)));
      const tools = buildDocumentWorkTools({ workspaceDir: workspace, tempDir: own,
        indexPath: join(fixture.root, "index/materials.md"), venvDir: join(fixture.root, "absent-venv") });
      const call = (name: string, params: object) => tools.find(t => t.name === name)!.execute("test", params, undefined, undefined, {} as never);
      const foreign = join(other, "private.docx");
      await writeFile(foreign, "private");
      await expect(call("document_inspect", { source: foreign })).rejects.toThrow("本群");
      await expect(call("document_render", { source: foreign })).rejects.toThrow("本群");
      await expect(call("document_compose", { items: [{ source: foreign }] })).rejects.toThrow("本群");
      await expect(call("document_build", { format: "docx", template: foreign, content: "# x" })).rejects.toThrow("本群");
      const foreignImage = join(other, "p.png");
      await writeFile(foreignImage, "png");
      await expect(call("document_build", { format: "pptx", content: "# x\n\n![图](" + foreignImage.replaceAll("\\", "/") + ")" })).rejects.toThrow("本群");
      await expect(call("document_build", { format: "pptx", content: "# x", keepSlides: [1] })).rejects.toThrow("模板");
      await expect(call("document_compose", { items: [{ content: "# 无文件来源" }] })).rejects.toThrow("第一项");
      const source = join(workspace, "source.docx");
      await writeFile(source, "unchanged");
      await expect(call("document_patch", { source, digest: "0".repeat(64), edits: [
        { part: "word/document.xml", paragraph: 1, before: "a", after: "b" },
      ] })).rejects.toThrow("已变化");
      await expect(call("document_patch", { source, digest: createHash("sha256").update("unchanged").digest("hex"),
        filename: "NUL.docx", edits: [] })).rejects.toThrow("filename");
      expect(await readFile(source, "utf8")).toBe("unchanged");
    } finally { await fixture.cleanup(); }
  });
});
