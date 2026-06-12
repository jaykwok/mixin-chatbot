import os
import time
import json
import aiosqlite
import logging
from collections import OrderedDict
from config import SESSION_TIMEOUT, MAX_HISTORY_MESSAGES, MAX_CACHE_SIZE, MAX_DB_SIZE_BYTES, TARGET_DB_SIZE_BYTES, MAX_ADMIN_SESSIONS

logger = logging.getLogger(__name__)

# SQLite 数据库路径
DB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DB_DIR, "sessions.db")

# 内存 LRU 缓存
_cache = OrderedDict()

# 持久数据库连接（单 worker，复用同一连接）
_db: aiosqlite.Connection | None = None


async def _get_db():
    """获取持久 aiosqlite 连接"""
    global _db
    if _db is None:
        os.makedirs(DB_DIR, exist_ok=True)
        _db = await aiosqlite.connect(DB_PATH, timeout=10)
        await _db.execute("PRAGMA journal_mode=WAL")
        await _db.execute("PRAGMA synchronous=NORMAL")
    return _db


async def close_db():
    """关闭数据库连接（应用关闭时调用）"""
    global _db
    if _db is not None:
        await _db.close()
        _db = None


async def init_db():
    """初始化数据库表（应用启动时调用）"""
    db = await _get_db()
    await db.execute("PRAGMA auto_vacuum=INCREMENTAL")
    await db.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            phone TEXT PRIMARY KEY,
            messages TEXT NOT NULL DEFAULT '[]',
            last_active REAL NOT NULL,
            group_id TEXT NOT NULL DEFAULT ''
        )
    """)
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_last_active ON sessions(last_active)"
    )
    await db.commit()


async def get_session(phone):
    """获取用户会话消息列表，不存在或已过期返回空列表"""
    current_time = time.time()

    # 先查内存缓存
    if phone in _cache:
        session = _cache[phone]
        if SESSION_TIMEOUT <= 0 or current_time - session["last_active"] <= SESSION_TIMEOUT:
            _cache.move_to_end(phone)
            return list(session["messages"])
        else:
            del _cache[phone]

    # 查 SQLite
    db = await _get_db()
    async with db.execute(
        "SELECT messages, last_active FROM sessions WHERE phone = ?", (phone,)
    ) as cursor:
        row = await cursor.fetchone()

    if row and (SESSION_TIMEOUT <= 0 or current_time - row[1] <= SESSION_TIMEOUT):
        messages = json.loads(row[0])
        _cache_put(phone, messages, row[1])
        return messages

    return []


async def save_session(phone, messages, group_id=""):
    """保存用户会话（写入 SQLite + 更新缓存）"""
    current_time = time.time()

    # 截断历史消息
    if len(messages) > MAX_HISTORY_MESSAGES:
        messages = messages[-MAX_HISTORY_MESSAGES:]

    messages_json = json.dumps(messages, ensure_ascii=False)

    db = await _get_db()
    await db.execute(
        """INSERT INTO sessions (phone, messages, last_active, group_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(phone) DO UPDATE SET
               messages = excluded.messages,
               last_active = excluded.last_active,
               group_id = excluded.group_id""",
        (phone, messages_json, current_time, group_id),
    )
    await db.commit()

    _cache_put(phone, messages, current_time, group_id)


async def get_all_sessions():
    """获取所有活跃会话信息（供管理页面使用），最多返回 MAX_ADMIN_SESSIONS 条"""
    db = await _get_db()
    if SESSION_TIMEOUT > 0:
        cutoff = time.time() - SESSION_TIMEOUT
        async with db.execute(
            "SELECT phone, messages, last_active, group_id FROM sessions WHERE last_active > ? ORDER BY last_active DESC LIMIT ?",
            (cutoff, MAX_ADMIN_SESSIONS),
        ) as cursor:
            rows = await cursor.fetchall()
    else:
        async with db.execute(
            "SELECT phone, messages, last_active, group_id FROM sessions ORDER BY last_active DESC LIMIT ?",
            (MAX_ADMIN_SESSIONS,),
        ) as cursor:
            rows = await cursor.fetchall()
    return [
        {
            "phone": row[0],
            "messages": json.loads(row[1]),
            "last_active": row[2],
            "group_id": row[3] if len(row) > 3 else "",
        }
        for row in rows
    ]


async def get_session_count():
    """获取活跃会话数量"""
    db = await _get_db()
    if SESSION_TIMEOUT > 0:
        cutoff = time.time() - SESSION_TIMEOUT
        async with db.execute(
            "SELECT COUNT(*) FROM sessions WHERE last_active > ?", (cutoff,)
        ) as cursor:
            row = await cursor.fetchone()
    else:
        async with db.execute("SELECT COUNT(*) FROM sessions") as cursor:
            row = await cursor.fetchone()
    return row[0]


async def clean_expired_sessions():
    """清理过期会话 + 磁盘容量控制"""
    db = await _get_db()
    cleaned = 0

    # 仅在设置了超时时间时清理过期会话
    if SESSION_TIMEOUT > 0:
        cutoff = time.time() - SESSION_TIMEOUT
        cursor = await db.execute(
            "DELETE FROM sessions WHERE last_active <= ?", (cutoff,)
        )
        cleaned = cursor.rowcount
        await db.commit()

    # 检查磁盘容量
    if os.path.exists(DB_PATH):
        db_size = os.path.getsize(DB_PATH)
        if db_size > MAX_DB_SIZE_BYTES:
            logger.warning(
                f"数据库大小 {db_size / 1024 / 1024:.0f}MB 超过限制，开始清理"
            )
            cleaned += await _shrink_db(db)

    # 大量删除后回收空间
    if cleaned > 50:
        await db.execute("PRAGMA incremental_vacuum")
        await db.commit()

    # 清理内存缓存中的过期条目
    if SESSION_TIMEOUT > 0:
        expired_keys = [
            k for k, v in _cache.items() if time.time() - v["last_active"] > SESSION_TIMEOUT
        ]
        for k in expired_keys:
            del _cache[k]

    if cleaned > 0:
        logger.info(f"清理了 {cleaned} 个会话")
    return cleaned


async def _shrink_db(db):
    """缩减数据库到目标大小（基于行数比例估算，避免 WAL 模式下文件大小不准确的问题）"""
    db_size = os.path.getsize(DB_PATH)
    if db_size <= TARGET_DB_SIZE_BYTES:
        return 0

    # 获取总行数
    async with db.execute("SELECT COUNT(*) FROM sessions") as cursor:
        row = await cursor.fetchone()
    total = row[0]
    if total == 0:
        return 0

    # 按比例估算需要删除的行数
    ratio = 1 - TARGET_DB_SIZE_BYTES / db_size
    delete_count = max(int(total * ratio), 100)

    cursor = await db.execute(
        "DELETE FROM sessions WHERE phone IN "
        "(SELECT phone FROM sessions ORDER BY last_active ASC LIMIT ?)",
        (delete_count,),
    )
    cleaned = cursor.rowcount
    await db.commit()
    return cleaned


def _cache_put(phone, messages, last_active, group_id=""):
    """写入 LRU 缓存"""
    _cache[phone] = {"messages": messages, "last_active": last_active, "group_id": group_id}
    _cache.move_to_end(phone)
    while len(_cache) > MAX_CACHE_SIZE:
        _cache.popitem(last=False)
