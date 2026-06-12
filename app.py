import time
import asyncio
import logging
from collections import OrderedDict
from urllib.parse import urlparse
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse

from utils import setup_logging
from session_manager import init_db, get_all_sessions, clean_expired_sessions, close_db
from ai_service import get_ai_response
from im_service import send_message_to_im, close_client
from auth import verify_auth
from config import (
    GROUP_CONFIGS, DEFAULT_GROUP_CONFIG, VALID_HOSTNAMES,
    REQUIRED_WEBHOOK_FIELDS, DEDUP_TTL, MAX_DEDUP_SIZE, CLEANUP_INTERVAL,
)

# 初始化日志
setup_logging()
logger = logging.getLogger(__name__)

# 请求去重（OrderedDict 保持插入顺序，清理时从头部弹出过期条目）
_recent_requests: OrderedDict[str, float] = OrderedDict()


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    await init_db()
    cleanup_task = asyncio.create_task(_background_cleanup())
    logger.info("服务启动完成，监听端口: 1011")
    yield
    cleanup_task.cancel()
    await close_client()
    await close_db()


app = FastAPI(title="AI Chatbot", lifespan=lifespan)

# 挂载静态文件
app.mount("/static", StaticFiles(directory="static"), name="static")


def get_client_ip(request: Request) -> str:
    """从请求中提取客户端 IP"""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "Unknown"


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

    return phone, group_id, content, callback_url


def is_duplicate_request(phone: str, content: str) -> bool:
    """检查是否为重复请求（OrderedDict 按插入顺序清理过期条目）"""
    now = time.time()
    key = f"{phone}:{content}"

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


async def process_request(
    content: str, phone: str, group_id: str, callback_url: str, client_ip: str
):
    """后台异步处理请求"""
    start_time = time.time()
    logger.info(f"请求处理开始 - 用户: {phone}, IP: {client_ip}")

    try:
        ai_response = await get_ai_response(content, phone, group_id)
        await send_message_to_im(ai_response, group_id, phone, callback_url)

        elapsed = time.time() - start_time
        logger.info(f"请求处理完成 - 用户: {phone}, 耗时: {elapsed:.2f}秒")
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"请求处理失败 - 用户: {phone}, 耗时: {elapsed:.2f}秒, 错误: {e}")
        try:
            await send_message_to_im(
                "抱歉，处理您的请求时出现了问题，请稍后再试。",
                group_id,
                phone,
                callback_url,
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

    phone, group_id, content, callback_url = validate_webhook_data(data)

    logger.info(
        f"收到请求 - IP: {client_ip}, 用户: {phone}, "
        f"群组: {group_id}, 内容: {content[:50]}..."
    )

    if is_duplicate_request(phone, content):
        logger.info(f"跳过重复请求 - 用户: {phone}")
        return {"status": "success"}

    # 异步处理：立即返回 200
    asyncio.create_task(
        process_request(content, phone, group_id, callback_url, client_ip)
    )

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
