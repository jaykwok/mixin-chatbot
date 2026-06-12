import asyncio
import logging
from openai import AsyncOpenAI
from config import (
    DASHSCOPE_API_KEY, AI_BASE_URL, AI_TIMEOUT, AI_MAX_RETRIES,
    GROUP_CONFIGS, DEFAULT_GROUP_CONFIG,
)
from session_manager import get_session, save_session

logger = logging.getLogger(__name__)

# 异步 OpenAI 客户端
client = AsyncOpenAI(
    api_key=DASHSCOPE_API_KEY,
    base_url=AI_BASE_URL,
    timeout=AI_TIMEOUT,
    max_retries=AI_MAX_RETRIES,
)

# per-user 锁，防止同一用户并发请求导致会话历史丢失
_user_locks: dict[str, asyncio.Lock] = {}


async def get_ai_response(message: str, phone: str, group_id: str) -> str:
    """调用 AI 模型生成对话回复"""
    # 获取或创建该用户的锁，确保同一用户的请求串行处理
    if phone not in _user_locks:
        _user_locks[phone] = asyncio.Lock()
    lock = _user_locks[phone]

    async with lock:
        try:
            group_config = GROUP_CONFIGS.get(group_id, {})
            model = group_config.get("model", DEFAULT_GROUP_CONFIG["model"])
            system_prompt = DEFAULT_GROUP_CONFIG["system_prompt"]

            # 构建消息
            messages = [{"role": "system", "content": system_prompt}]

            # 从持久化存储获取历史消息
            history = await get_session(phone)
            messages.extend(history)
            messages.append({"role": "user", "content": message})

            # 调用模型（异步流式接收，拼接完整后返回）
            completion = await client.chat.completions.create(
                model=model,
                messages=messages,
                stream=True,
            )

            parts = []
            async for chunk in completion:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content is not None:
                    parts.append(delta.content)
            ai_response = "".join(parts)

            # 保存会话历史
            history.append({"role": "user", "content": message})
            history.append({"role": "assistant", "content": ai_response})
            await save_session(phone, history, group_id)

            return ai_response

        except Exception as e:
            logger.error(f"获取AI回复时出错: {e}, 群组: {group_id}")
            return "抱歉，我遇到了技术问题，请稍后再试。"
