// 发送层：向量子密信群聊 webhook 发送多种消息 + 附件上传。
// 对应 Python 版 im_service.py，复刻已实测验证的 A 套协议。
import { log } from "../lib/log.ts";
import { IM_RETRY_COUNT, IM_RETRY_DELAY } from "../lib/config.ts";

const IM_SEND_HOST = "imtwo.zdxlz.com";
const UPLOAD_PATH = "/im-external/v1/webhook/upload-attachment";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 从 callBackUrl（send?key=xxx）解析机器人 key，用于上传附件。 */
export function extractKeyFromCallback(callbackUrl: string): string | null {
  try {
    return new URL(callbackUrl).searchParams.get("key");
  } catch {
    return null;
  }
}

/** 带重试的 JSON POST，成功（HTTP 200）返回 true。 */
async function postWithRetry(
  url: string,
  payload: unknown,
  label = "消息"
): Promise<boolean> {
  for (let attempt = 0; attempt < IM_RETRY_COUNT; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.status === 200) return true;
      log.error(`${label}发送失败，状态码: ${resp.status}`);
    } catch (e) {
      log.error(`${label}发送异常: ${String(e)}，第${attempt + 1}次`);
    }
    if (attempt === 0) await sleep(IM_RETRY_DELAY);
  }
  log.error(`${label}最终发送失败`);
  return false;
}

/** 从 markdown 正文提取首行作卡片标题（去标记、截断）。A 套 markdown 的 title 必填。 */
export function buildMarkdownTitle(content: string, limit = 24): string {
  const firstLine = content.trim().split("\n", 1)[0]?.trim() ?? "";
  let clean = firstLine.replace(/^[#>\*\-\d\.\s]+/, "");
  clean = clean.replace(/^[*_`\t ]+/, "").replace(/[*_`\t ]+$/, "");
  return (clean || "AI 回复").slice(0, limit);
}

// ===== 消息构建器（A 套群聊 webhook 协议，已实测验证）=====
export function buildText(content: string, groupId: string, phone: string) {
  return {
    type: "text" as const,
    textMsg: {
      content,
      isMentioned: true,
      mentionType: 2,
      mentionedMobileList: [phone],
      groupId,
    },
  };
}

export function buildMarkdown(content: string) {
  return {
    type: "markdown" as const,
    markdown: { title: buildMarkdownTitle(content), content },
  };
}

export function buildImage(fileId: string, width?: number, height?: number) {
  const body: Record<string, unknown> = { fileId };
  if (width !== undefined) body.width = width;
  if (height !== undefined) body.height = height;
  return { type: "image" as const, imageMsg: body };
}

export function buildFile(fileId: string) {
  return { type: "file" as const, fileMsg: { fileId } };
}

// ===== 发送接口 =====
export async function sendText(
  content: string,
  groupId: string,
  phone: string,
  callbackUrl: string
): Promise<boolean> {
  const ok = await postWithRetry(callbackUrl, buildText(content, groupId, phone), "text");
  if (ok) log.info(`消息发送成功，用户: ${phone}`);
  return ok;
}

export async function sendMarkdown(
  content: string,
  callbackUrl: string,
  phone?: string
): Promise<boolean> {
  const ok = await postWithRetry(callbackUrl, buildMarkdown(content), "markdown");
  if (ok) log.info(`markdown 发送成功，用户: ${phone ?? "-"}`);
  return ok;
}

/** 群聊回复：markdown 正文 + text@ 通知（双消息）。
 *  markdown 不支持 @（已实测），故用一条 text 消息触发通知，markdown 承载渲染内容。 */
export async function sendReplyWithMention(
  content: string,
  groupId: string,
  phone: string,
  callbackUrl: string
): Promise<boolean> {
  const summary = buildMarkdownTitle(content, 40);
  await postWithRetry(callbackUrl, buildMarkdown(content), "markdown");
  const ok = await postWithRetry(callbackUrl, buildText(summary, groupId, phone), "text@");
  if (ok) log.info(`回复发送完成（markdown + text@），用户: ${phone}`);
  return ok;
}

export async function sendImage(
  fileId: string,
  callbackUrl: string,
  phone?: string,
  width?: number,
  height?: number
): Promise<boolean> {
  const ok = await postWithRetry(callbackUrl, buildImage(fileId, width, height), "image");
  if (ok) log.info(`image 发送成功，用户: ${phone ?? "-"}`);
  return ok;
}

export async function sendFile(
  fileId: string,
  callbackUrl: string,
  phone?: string
): Promise<boolean> {
  const ok = await postWithRetry(callbackUrl, buildFile(fileId), "file");
  if (ok) log.info(`file 发送成功，用户: ${phone ?? "-"}`);
  return ok;
}

/** 上传附件，返回 fileId（失败返回 null）。
 *  fileType: 'image' | 'file'（决定 type 参数：1=图片，2=文件）。
 *  data 为内存字节，不落盘，适配只读容器；key 从 callBackUrl 提取。 */
export async function uploadAttachment(
  callbackUrl: string,
  data: Uint8Array,
  filename: string,
  fileType: "image" | "file"
): Promise<string | null> {
  const key = extractKeyFromCallback(callbackUrl);
  if (!key) {
    log.error("无法从 callBackUrl 提取 key，附件上传失败");
    return null;
  }
  const typeEnum = fileType === "image" ? "1" : "2";
  const url = `https://${IM_SEND_HOST}${UPLOAD_PATH}?key=${encodeURIComponent(key)}&type=${typeEnum}`;
  try {
    const form = new FormData();
    form.append("file", new Blob([data]), filename);
    const resp = await fetch(url, { method: "POST", body: form });
    if (!resp.ok) {
      log.error(`附件上传 HTTP 失败: ${resp.status}`);
      return null;
    }
    const result = (await resp.json()) as {
      ok?: boolean;
      code?: number;
      data?: { id?: string };
    };
    if (result.ok && result.code === 200) {
      const fileId = result.data?.id ?? null;
      log.info(`附件上传成功: ${filename} -> ${fileId}`);
      return fileId;
    }
    log.error(`附件上传接口返回错误: ${JSON.stringify(result)}`);
  } catch (e) {
    log.error(`附件上传异常: ${String(e)}`);
  }
  return null;
}
