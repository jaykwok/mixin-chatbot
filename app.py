import time
import asyncio
import logging
import hashlib
from collections import OrderedDict
from urllib.parse import urlparse
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse

from utils import setup_logging
from session_manager import init_db, get_all_sessions, clean_expired_sessions, close_db
from ai_service import get_ai_response
from im_service import (
    send_message_to_im,
    send_markdown_to_im,
    send_reply_with_mention,
    close_client,
)
from auth import verify_auth
from config import (
    GROUP_CONFIGS, DEFAULT_GROUP_CONFIG, VALID_HOSTNAMES,
    REQUIRED_WEBHOOK_FIELDS, DEDUP_TTL, MAX_DEDUP_SIZE, CLEANUP_INTERVAL,
    RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_REQUESTS, DEBUG,
    RATE_LIMIT_CLEANUP_INTERVAL, RATE_LIMIT_MAX_USERS, VALID_CALLBACK_PORTS,
    ALLOWED_ROBOT_IDS, ALLOWED_IPS,
)

# 初始化日志
setup_logging()
logger = logging.getLogger(__name__)

# 请求去重（OrderedDict 保持插入顺序，清理时从头部弹出过期条目）
_recent_requests: OrderedDict[str, float] = OrderedDict()

# 速率限制（每用户在窗口内的请求时间戳列表）
_rate_limits: dict[str, list] = {}

# 后台任务引用集合，防止任务被 GC 回收导致静默取消
_background_tasks: set = set()


async def _background_cleanup():
    """后台定时清理过期会话"""
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL)
        try:
            cleaned = await clean_expired_sessions()
            if cleaned > 0:
                logger.info(f"后台清理了 {cleaned} 个过期会话")
        except Exception as e:
            logger.error(f"后台清理出错: {e}")


async def _background_rate_limit_cleanup():
    """后台定时清理速率限制字典，防止内存无限增长"""
    while True:
        await asyncio.sleep(RATE_LIMIT_CLEANUP_INTERVAL)
        try:
            cleanup_rate_limits()
        except Exception as e:
            logger.error(f"速率限制清理出错: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    await init_db()
    cleanup_task = asyncio.create_task(_background_cleanup())
    rate_limit_cleanup_task = asyncio.create_task(_background_rate_limit_cleanup())
    logger.info("服务启动完成，监听端口: 1011")
    yield
    cleanup_task.cancel()
    rate_limit_cleanup_task.cancel()
    for task in (cleanup_task, rate_limit_cleanup_task):
        try:
            await task
        except asyncio.CancelledError:
            pass
    await close_client()
    await close_db()


app = FastAPI(title="量子密信聊天机器人", lifespan=lifespan)

# 挂载静态文件
app.mount("/static", StaticFiles(directory="static"), name="static")


def get_client_ip(request: Request) -> str:
    """从请求中提取客户端 IP"""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "Unknown"


def authorize_webhook(data: dict, client_ip: str):
    """webhook 鉴权：robotId 白名单（强校验）+ 来源 IP 白名单（可选）。

    IM 平台不携带签名，只能基于请求固有特征校验：
    - robotId 必须在 ALLOWED_ROBOT_IDS 内（攻击者不知道 robotId 即无法伪造）
    - 若配置了 ALLOWED_IPS，来源 IP 必须在白名单内（未配置则跳过，便于观察期）
    """
    if not ALLOWED_ROBOT_IDS:
        raise HTTPException(
            503, "未配置 ROBOT_IDS 白名单，服务暂不可用"
        )
    robot_id = str(data.get("robotId", "")).strip()
    if robot_id not in ALLOWED_ROBOT_IDS:
        logger.warning(f"webhook 鉴权失败 - robotId 不在白名单: {robot_id}, IP: {client_ip}")
        raise HTTPException(403, "拒绝访问")

    if ALLOWED_IPS and client_ip not in ALLOWED_IPS:
        logger.warning(f"webhook 鉴权失败 - IP 不在白名单: {client_ip}, robotId: {robot_id}")
        raise HTTPException(403, "拒绝访问")


def validate_webhook_data(data: dict) -> tuple:
    """验证并提取 webhook 数据"""
    missing = [f for f in REQUIRED_WEBHOOK_FIELDS if f not in data]
    if missing:
        raise HTTPException(400, f"缺少必要字段: {missing}")

    if data.get("type") != "text":
        raise HTTPException(400, f"不支持的消息类型: {data.get('type')}")

    phone = data.get("phone", "").strip()
    group_id = data.get("groupId", "").strip()
    callback_url = data.get("callBackUrl", "").strip()

    text_msg = data.get("textMsg", {})
    content = text_msg.get("content", "").strip() if isinstance(text_msg, dict) else ""

    if not phone or not group_id or not content:
        raise HTTPException(400, "phone、groupId 或 content 不能为空")

    parsed = urlparse(callback_url)
    if parsed.scheme != "https" or parsed.hostname not in VALID_HOSTNAMES:
        raise HTTPException(403, f"无效的回调URL: {callback_url}")

    # 端口校验：未显式指定端口时 port 为 None（走默认 443），允许通过；
    # 显式指定端口时必须在白名单内（白名单为空则禁止任何非默认端口）
    if parsed.port is not None and parsed.port not in VALID_CALLBACK_PORTS:
        raise HTTPException(403, f"无效的回调URL端口: {parsed.port}")

    # 拒绝用户信息（user:pass@host）形式，防止绕过域名白名单
    if parsed.username or parsed.password:
        raise HTTPException(403, "回调URL不允许包含用户信息")

    return phone, group_id, content, callback_url


def is_duplicate_request(phone: str, content: str) -> bool:
    """检查是否为重复请求（OrderedDict 按插入顺序清理过期条目）"""
    now = time.time()
    # 用 hash 摘要作为 key，避免长消息导致内存膨胀
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    key = f"{phone}:{content_hash}"

    # 从头部弹出过期条目
    while _recent_requests:
        oldest_key, oldest_time = next(iter(_recent_requests.items()))
        if now - oldest_time > DEDUP_TTL:
            del _recent_requests[oldest_key]
        else:
            break

    if key in _recent_requests:
        return True

    _recent_requests[key] = now

    # 容量上限保护
    while len(_recent_requests) > MAX_DEDUP_SIZE:
        _recent_requests.popitem(last=False)

    return False


def is_rate_limited(phone: str) -> bool:
    """检查用户是否超出速率限制"""
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW

    timestamps = _rate_limits.get(phone, [])
    # 移除窗口外的时间戳
    timestamps = [t for t in timestamps if t > window_start]

    if len(timestamps) >= RATE_LIMIT_MAX_REQUESTS:
        _rate_limits[phone] = timestamps
        return True

    timestamps.append(now)
    _rate_limits[phone] = timestamps
    return False


def cleanup_rate_limits():
    """清理速率限制字典中窗口外已无时间戳的用户，防止内存无限增长"""
    if not _rate_limits:
        return
    window_start = time.time() - RATE_LIMIT_WINDOW
    # 删除窗口内已无任何时间戳的用户
    stale = [
        phone for phone, ts in _rate_limits.items()
        if not any(t > window_start for t in ts)
    ]
    for phone in stale:
        del _rate_limits[phone]
    # 兜底：若仍超容量，按最近活跃时间淘汰最旧的
    if len(_rate_limits) > RATE_LIMIT_MAX_USERS:
        # 取每个用户最新时间戳，按升序淘汰
        sorted_phones = sorted(
            _rate_limits,
            key=lambda p: max(_rate_limits[p]) if _rate_limits[p] else 0,
        )
        excess = len(_rate_limits) - RATE_LIMIT_MAX_USERS
        for phone in sorted_phones[:excess]:
            del _rate_limits[phone]


async def process_request(
    content: str, phone: str, group_id: str, callback_url: str, client_ip: str
):
    """后台异步处理请求"""
    start_time = time.time()
    logger.info(f"请求处理开始 - 用户: {phone}, IP: {client_ip}")

    try:
        ai_response = await get_ai_response(content, phone, group_id)
        # 调试模式：记录 AI 响应内容
        if DEBUG:
            logger.info(
                "[DEBUG] AI 响应 - 用户: %s, 响应长度: %d, 响应内容: %s",
                phone, len(ai_response), ai_response,
            )
        await send_reply_with_mention(ai_response, group_id, phone, callback_url)

        elapsed = time.time() - start_time
        logger.info(f"请求处理完成 - 用户: {phone}, 耗时: {elapsed:.2f}秒")
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"请求处理失败 - 用户: {phone}, 耗时: {elapsed:.2f}秒, 错误: {e}")
        try:
            await send_markdown_to_im(
                "⚠️ 抱歉，处理您的请求时出现了问题，请稍后再试。",
                callback_url,
                phone,
            )
        except Exception as send_err:
            logger.error(f"错误回复发送失败 - 用户: {phone}, 错误: {send_err}")


@app.post("/webhook")
async def webhook(request: Request):
    """处理来自 IM 平台的 webhook 请求"""
    client_ip = get_client_ip(request)

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "请求必须是JSON格式")

    # 调试模式：记录完整请求头和 body，用于分析 IM 平台转发特征
    if DEBUG:
        try:
            import json as _json
            logger.info(
                "[DEBUG] webhook 原始请求 - IP: %s, headers: %s, body: %s",
                client_ip,
                dict(request.headers),
                _json.dumps(data, ensure_ascii=False),
            )
        except Exception as dbg_err:
            logger.error(f"[DEBUG] 记录调试日志失败: {dbg_err}")

    # 鉴权：robotId 白名单 + 来源 IP 白名单（可选）
    authorize_webhook(data, client_ip)

    phone, group_id, content, callback_url = validate_webhook_data(data)

    logger.info(
        f"收到请求 - IP: {client_ip}, 用户: {phone}, "
        f"群组: {group_id}, 内容长度: {len(content)}"
    )

    if is_duplicate_request(phone, content):
        logger.info(f"跳过重复请求 - 用户: {phone}")
        return {"status": "success"}

    if is_rate_limited(phone):
        logger.warning(f"速率限制触发 - 用户: {phone}")
        raise HTTPException(429, "请求过于频繁，请稍后再试")

    # 异步处理：立即返回 200
    task = asyncio.create_task(
        process_request(content, phone, group_id, callback_url, client_ip)
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return {"status": "success"}


@app.get("/admin")
async def admin(username: str = Depends(verify_auth)):
    """管理页面"""
    return FileResponse("static/admin.html")


@app.get("/admin/api")
async def admin_api(username: str = Depends(verify_auth)):
    """管理页面数据接口"""
    all_sessions = await get_all_sessions()
    current_time = time.time()

    sessions_info = {}
    for session in all_sessions:
        phone = session["phone"]
        messages = session["messages"]
        group_id = session.get("group_id", "")
        group_config = GROUP_CONFIGS.get(group_id, {})
        model = group_config.get("model", DEFAULT_GROUP_CONFIG["model"])
        sessions_info[phone] = {
            "message_count": len(messages),
            "group_id": group_id,
            "model": model,
            "last_active": time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(session["last_active"])
            ),
            "active_duration": int(current_time - session["last_active"]),
            "recent_messages": messages if messages else [],
        }

    return {
        "status": "success",
        "active_sessions": len(sessions_info),
        "sessions": sessions_info,
        "default_model": DEFAULT_GROUP_CONFIG["model"],
        "current_time": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


@app.get("/favicon.svg")
async def favicon():
    return FileResponse("static/favicon.svg")


@app.get("/favicon.ico")
async def favicon_ico():
    return FileResponse("static/favicon.svg")


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"status": "error", "message": exc.detail},
        headers=exc.headers,
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    logger.error(f"未处理异常 - IP: {get_client_ip(request)}, 错误: {exc}")
    return JSONResponse(
        status_code=500,
        content={"status": "error", "message": "内部服务器错误"},
    )
