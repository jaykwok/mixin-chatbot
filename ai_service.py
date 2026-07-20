import asyncio
import logging
from openai import AsyncOpenAI
from config import (
    DASHSCOPE_API_KEY, AI_BASE_URL, AI_TIMEOUT, AI_MAX_RETRIES,
    GROUP_CONFIGS, DEFAULT_GROUP_CONFIG, MAX_USER_LOCKS,
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


def _get_user_lock(phone: str) -> asyncio.Lock:
    """获取或创建用户锁，超出上限时清理空闲锁。

    单线程 asyncio 下，locked() 检查与 del 之间无 await，原子安全：
    locked() 为 False 即表示无协程持有该锁（对应请求已结束），
    删除后新请求创建新锁不会破坏互斥语义。
    """
    if phone not in _user_locks:
        # 容量超限时清理未被持有的锁
        if len(_user_locks) >= MAX_USER_LOCKS:
            idle = [k for k, v in _user_locks.items() if not v.locked()]
            for k in idle:
                del _user_locks[k]
            # 若清理后仍超限（所有锁都被持有），强制淘汰最早的空闲锁以外的条目
            # 极端情况下保留当前 phone 即将创建的槽位
        _user_locks[phone] = asyncio.Lock()
    return _user_locks[phone]


async def get_ai_response(message: str, phone: str, group_id: str) -> str:
    """调用 AI 模型生成对话回复"""
    lock = _get_user_lock(phone)

    async with lock:
        try:
            model = GROUP_CONFIGS.get(group_id, {}).get("model", DEFAULT_GROUP_CONFIG["model"])
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
