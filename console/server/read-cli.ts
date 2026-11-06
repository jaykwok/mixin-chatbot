// Runs in the existing supervised query process pool, so timeouts and browser disconnects reclaim the process tree.
import { cliArgs } from "../../ops/lib/cli.ts";
import { readPage, READ_PAGES } from "./read-pages.ts";
import type { ReadPageName, ReadFilters } from "./read-pages.ts";

if (import.meta.main) {
  try {
    const { values, positionals } = cliArgs(process.argv.slice(2), { project: { type: "string" }, page: { type: "string" }, filters: { type: "string" } });
    if (positionals.length || !values.project || !READ_PAGES.includes(values.page as ReadPageName)) throw new Error("只读页面参数无效");
    const filters = JSON.parse(Buffer.from(values.filters || "e30=", "base64").toString("utf8")) as ReadFilters;
    console.log(JSON.stringify(await readPage(values.project, values.page as ReadPageName, filters)));
  } catch { console.error("读取失败，请检查部署状态、文件格式和权限"); process.exitCode = 1; }
}
