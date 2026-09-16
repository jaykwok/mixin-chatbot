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
    prompt: "## 文档加工\nWord/PPT 修改、组装或成稿可按需读取项目提供的 document-work skill。它提供方法和工具说明；资料选择、结构与执行路径由你根据本次任务决定。read 返回的页面图片可用于视觉检查；未实际检查时不声称版式已通过。",
  };
}
