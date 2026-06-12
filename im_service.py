import asyncio
import logging
import httpx
from config import IM_TIMEOUT, IM_RETRY_COUNT, IM_RETRY_DELAY

logger = logging.getLogger(__name__)

# 异步 HTTP 客户端（复用连接）
_client: httpx.AsyncClient | None = None


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


async def send_message_to_im(content, group_id, phone, callback_url):
    """发送消息回 IM 平台（失败重试一次）"""
    payload = {
        "type": "text",
        "textMsg": {
            "content": content,
            "isMentioned": True,
            "mentionType": 2,
            "mentionedMobileList": [phone],
            "groupId": group_id,
        },
    }

    client = _get_client()
    for attempt in range(IM_RETRY_COUNT):
        try:
            response = await client.post(callback_url, json=payload)
            if response.status_code == 200:
                logger.info(f"消息发送成功，用户: {phone}")
                return True
            logger.error(
                f"IM回调失败，状态码: {response.status_code}, 用户: {phone}"
            )
        except Exception as e:
            logger.error(f"IM回调异常: {e}, 用户: {phone}, 第{attempt + 1}次")

        if attempt == 0:
            await asyncio.sleep(IM_RETRY_DELAY)

    logger.error(f"IM回调最终失败，用户: {phone}")
    return False
