import { fileURLToPath } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { DocumentOptions } from "../../document-extract.ts";
import type { AgentModule } from "../../modules.ts";
import { buildDocumentWorkTools } from "./tools.ts";

/** Application-owned resources only; group material never participates in discovery. */
export function loadDocumentWork(options: DocumentOptions): AgentModule {
  const skillRoot = fileURLToPath(new URL("./skills/document-work/", import.meta.url));
  const skills = loadSkills({ cwd: skillRoot, agentDir: skillRoot, skillPaths: [skillRoot], includeDefaults: false });
  if (skills.skills.length !== 1 || skills.diagnostics.length) {
    throw new Error("项目文档 skill 加载失败：" + JSON.stringify(skills.diagnostics));
  }
  return {
    tools: buildDocumentWorkTools(options), skills, readOnlyDirs: [skillRoot],
    prompt: "## 文档加工\nWord/PPT 修改、选编或在资料与模板基础上生成新文档时，先读取项目提供的 document-work skill。它说明四条主路径：局改（document_patch）、选编（document_compose）、按模板用 Markdown 生成（document_build 或 compose 的 content 项，页内短段自动排成卡片、流程、分层架构、时间轴等图示）以及看图检查（document_render）；资料中的图可用 document_images 提取后引用；带判断和回退的流程图在 Markdown 里写 ```mermaid 代码块。资料选择、结构与内容由你根据本次任务决定，排版交给工具。read 返回的页面图片可用于视觉检查；未实际检查时不声称版式已通过。",
  };
}
