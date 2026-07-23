import asyncio
import logging
import re
from urllib.parse import urlparse, parse_qs

import httpx
from config import IM_TIMEOUT, IM_RETRY_COUNT, IM_RETRY_DELAY

logger = logging.getLogger(__name__)

# 异步 HTTP 客户端（复用连接）
_client: httpx.AsyncClient | None = None

# 附件上传端点（与 callBackUrl 同源，已实测）
IM_SEND_HOST = "imtwo.zdxlz.com"
UPLOAD_PATH = "/im-external/v1/webhook/upload-attachment"


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=IM_TIMEOUT)
    return _client


async def close_client():
    """关闭 HTTP 客户端（应用关闭时调用）"""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def extract_key_from_callback(callback_url: str) -> str | None:
    """从 callBackUrl（形如 .../webhook/send?key=xxx）解析机器人 key，用于上传附件。

    chatbot 的 callBackUrl 本身就是 send?key=<机器人Key>，key 每次请求都携带，
    无需在 .env 单独配置——上传附件时从这里提取即可。
    """
    parsed = urlparse(callback_url)
    return parse_qs(parsed.query).get("key", [None])[0]


async def _post_with_retry(url: str, payload: dict, *, label: str = "消息") -> bool:
    """带重试的 JSON POST，成功（HTTP 200）返回 True。"""
    client = _get_client()
    for attempt in range(IM_RETRY_COUNT):
        try:
            response = await client.post(url, json=payload)
            if response.status_code == 200:
                return True
            logger.error(f"{label}发送失败，状态码: {response.status_code}")
        except Exception as e:
            logger.error(f"{label}发送异常: {e}，第{attempt + 1}次")
        if attempt == 0:
            await asyncio.sleep(IM_RETRY_DELAY)

    logger.error(f"{label}最终发送失败")
    return False


def _build_markdown_title(content: str, limit: int = 24) -> str:
    """从 markdown 正文提取首行作卡片标题（去标记、截断）。

    A 套群聊 markdown 消息的 title 为必填字段，取正文首行的纯文本摘要。
    """
    first_line = content.strip().split("\n", 1)[0].strip()
    clean = re.sub(r"^[#>\*\-\d\.\s]+", "", first_line).strip("*_` \t")
    if not clean:
        clean = "AI 回复"
    return clean[:limit]


# ===== 消息构建器（A 套群聊 webhook 协议，已实测验证）=====
def build_text(content: str, group_id: str, phone: str) -> dict:
    """text 消息（带 @ 发问者，用于需要强通知的场景）。"""
    return {
        "type": "text",
        "textMsg": {
            "content": content,
            "isMentioned": True,
            "mentionType": 2,
            "mentionedMobileList": [phone],
            "groupId": group_id,
        },
    }


def build_markdown(content: str) -> dict:
    """markdown 消息，客户端原生渲染（title 必填）。"""
    return {
        "type": "markdown",
        "markdown": {"title": _build_markdown_title(content), "content": content},
    }


def build_image(file_id: str, width: int | None = None, height: int | None = None) -> dict:
    """image 消息。width/height 可选（有则更精准，无则客户端按原图展示）。"""
    body: dict = {"fileId": file_id}
    if width is not None:
        body["width"] = width
    if height is not None:
        body["height"] = height
    return {"type": "image", "imageMsg": body}


def build_file(file_id: str) -> dict:
    """file 消息。"""
    return {"type": "file", "fileMsg": {"fileId": file_id}}


# ===== 发送接口 =====
async def send_message_to_im(content, group_id, phone, callback_url):
    """发送 text 回复（带 @）。保留供需要强通知的场景或错误兜底使用。"""
    ok = await _post_with_retry(callback_url, build_text(content, group_id, phone), label="text")
    if ok:
        logger.info(f"消息发送成功，用户: {phone}")
    return ok


async def send_markdown_to_im(content, callback_url, phone=None):
    """发送 markdown 回复（不 @，客户端原生渲染）。"""
    ok = await _post_with_retry(callback_url, build_markdown(content), label="markdown")
    if ok:
        logger.info(f"markdown 发送成功，用户: {phone}")
    return ok


async def send_reply_with_mention(content, group_id, phone, callback_url):
    """群聊回复：markdown 正文 + text@ 通知（双消息）。

    markdown 类型不支持 @（已实测：mention 字段无论放 textMsg 还是 markdown 内部，
    均被平台忽略），故用一条 text 消息 @ 发问者触发通知，markdown 消息承载完整渲染内容。

    顺序：先发 markdown 正文，再发 text@（按需求约定）。
    若想改为「text@ 在前、markdown 在后」，调换下面两行即可。
    """
    summary = _build_markdown_title(content, limit=40)
    await _post_with_retry(callback_url, build_markdown(content), label="markdown")
    ok = await _post_with_retry(callback_url, build_text(summary, group_id, phone), label="text@")
    if ok:
        logger.info(f"回复发送完成（markdown + text@），用户: {phone}")
    return ok


async def send_image_to_im(file_id, callback_url, phone=None, width=None, height=None):
    """发送 image 回复（不 @）。"""
    ok = await _post_with_retry(
        callback_url, build_image(file_id, width, height), label="image"
    )
    if ok:
        logger.info(f"image 发送成功，用户: {phone}")
    return ok


async def send_file_to_im(file_id, callback_url, phone=None):
    """发送 file 回复（不 @）。"""
    ok = await _post_with_retry(callback_url, build_file(file_id), label="file")
    if ok:
        logger.info(f"file 发送成功，用户: {phone}")
    return ok


async def upload_attachment(callback_url, data: bytes, filename: str, file_type: str):
    """上传附件，返回 file_id（失败返回 None）。

    - file_type: 'image' 或 'file'（决定上传接口 type 参数：1=图片，2=文件）
    - data 为内存字节，不落盘，适配只读容器文件系统
    - key 从 callBackUrl 提取，无需额外配置
    """
    key = extract_key_from_callback(callback_url)
    if not key:
        logger.error("无法从 callBackUrl 提取 key，附件上传失败")
        return None

    type_enum = "1" if file_type == "image" else "2"
    url = f"https://{IM_SEND_HOST}{UPLOAD_PATH}?key={key}&type={type_enum}"
    client = _get_client()
    try:
        response = await client.post(
            url,
            files={"file": (filename, data, "application/octet-stream")},
            timeout=max(IM_TIMEOUT, 60.0),
        )
        response.raise_for_status()
        result = response.json()
        if result.get("ok") and result.get("code") == 200:
            file_id = result.get("data", {}).get("id")
            logger.info(f"附件上传成功: {filename} -> {file_id}")
            return file_id
        logger.error(f"附件上传接口返回错误: {result}")
    except Exception as e:
        logger.error(f"附件上传异常: {e}")
    return None
