// 从 Pi 组装好的 system prompt 里剪掉「pi 自身文档导航」那一段。
//
// 这段说的是：pi 的 README / docs / examples 在哪，问到 extensions、themes、skills、prompt
// templates、TUI、keybindings、SDK 时该读哪个 .md。对本项目它是纯负担：
//   - noExtensions / noSkills / noPromptTemplates / noThemes 全为 true，它导航的能力一个都没开；
//   - 它给的路径在 node_modules 下，而文件工具只放行 workspace 与调用者 tmp，模型真按
//     基座里「用 read 而不是 cat 看文件」那条 guideline 去读，只会先撞一次边界错误；
//   - 实测它占基座 2719 字符中的 1244 字符（46%）。按真实会话折算（566 次模型调用、
//     累计输入 177 万 token）约占全部输入的一成，而当前 provider 没有 prompt 缓存，每轮重付。
//
// 为什么不用 systemPromptOverride 整体换掉基座：那会连工具清单和 Pi 随工具版本演进的
// guidelines（edits[].oldText 必须精确匹配、同一文件多处修改合并成一次 edit 调用等）
// 一起丢掉，等于把它们冻结在今天。这里只剪掉确实无用的一段，其余照旧跟着上游升级。
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { log } from "../core/log.ts";

const SECTION_HEADER = "\n\nPi documentation (read only when";

/**
 * 剪掉 pi 文档段，定位不到时返回 undefined（调用方原样放行）。
 *
 * 只认标题行，段落结尾靠「连续的 `- ` 列表项到此为止」判断，而不是找下一个固定锚点：
 * 这一段之后紧跟的是本适配层追加的群聊上下文，用 `Current working directory:` 之类的
 * 尾部锚点去切会把追加内容一起切掉。上游增删列表项时这里仍然成立。
 */
export function stripPiDocsSection(systemPrompt: string): string | undefined {
  const start = systemPrompt.indexOf(SECTION_HEADER);
  if (start === -1) return undefined;
  // 标题行自身的结尾。
  let cursor = systemPrompt.indexOf("\n", start + SECTION_HEADER.length);
  if (cursor === -1) return undefined;
  while (cursor < systemPrompt.length) {
    const nextBreak = systemPrompt.indexOf("\n", cursor + 1);
    const line = systemPrompt.slice(
      cursor + 1,
      nextBreak === -1 ? undefined : nextBreak
    );
    if (!line.startsWith("- ")) break;
    if (nextBreak === -1) {
      cursor = systemPrompt.length;
      break;
    }
    cursor = nextBreak;
  }
  return systemPrompt.slice(0, start) + systemPrompt.slice(cursor);
}

// 上游改了措辞时只提醒一次，避免每个会话每一轮都刷一条同样的日志。
let warnedMissingSection = false;

export function createSystemPromptTrimExtension(): InlineExtension {
  return {
    name: "mixin-system-prompt-trim",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        const trimmed = stripPiDocsSection(event.systemPrompt);
        if (trimmed === undefined) {
          // 失败要退回完整 prompt，不能交出剪坏的半份：多花些 token 远好过让模型
          // 拿到一份结构被破坏的指令。
          if (!warnedMissingSection) {
            warnedMissingSection = true;
            log.warn(
              "未能在 Pi system prompt 中定位文档段（上游措辞可能已变），本轮起保持原样"
            );
          }
          return;
        }
        return { systemPrompt: trimmed };
      });
    },
  };
}
