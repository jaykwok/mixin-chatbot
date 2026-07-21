import os
from dotenv import load_dotenv

load_dotenv()


def _env(key: str, default=None):
    """大小写兼容读取环境变量：依次尝试原样、大写、小写。

    .env 中 DEBUG / debug / Debug 均可命中，避免大小写笔误导致配置不生效。
    """
    for variant in (key, key.upper(), key.lower()):
        val = os.getenv(variant)
        if val is not None and val != "":
            return val
    return default


# ===== 密钥 (from .env) =====
DASHSCOPE_API_KEY = _env("DASHSCOPE_API_KEY")
APP_USERNAME = _env("APP_USERNAME")
APP_PASSWORD = _env("APP_PASSWORD")

# 启动校验
_required = {"DASHSCOPE_API_KEY": DASHSCOPE_API_KEY, "APP_USERNAME": APP_USERNAME, "APP_PASSWORD": APP_PASSWORD}
_missing = [k for k, v in _required.items() if not v]
if _missing:
    raise RuntimeError(f"缺少必要环境变量: {', '.join(_missing)}")

# ===== AI 服务 =====
AI_BASE_URL = _env("AI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
AI_TIMEOUT = 60.0
AI_MAX_RETRIES = 1

# ===== IM 服务 =====
IM_TIMEOUT = 10.0
IM_RETRY_COUNT = 2      # 总尝试次数（首次 + 1次重试）
IM_RETRY_DELAY = 2      # 重试间隔（秒）

# ===== Webhook =====
VALID_HOSTNAMES = {"imtwo.zdxlz.com", "im.zdxlz.com"}
# 回调 URL 允许的端口（空集合表示仅允许默认 https 端口 443）
VALID_CALLBACK_PORTS: set[int] = set()
REQUIRED_WEBHOOK_FIELDS = ["type", "textMsg", "phone", "groupId", "callBackUrl"]
DEDUP_TTL = 30           # 请求去重窗口（秒）
MAX_DEDUP_SIZE = 1000    # 去重字典最大容量

# ===== Webhook 鉴权（基于请求固有特征，IM 平台不携带签名）=====
# robotId 白名单：必填，请求体 robotId 必须在此集合内（强校验）
#   .env 中 ROBOT_IDS=2038929310892589099,2038929310892589059
_robot_ids_raw = _env("ROBOT_IDS", "")
ALLOWED_ROBOT_IDS: set[str] = {
    s.strip() for s in _robot_ids_raw.split(",") if s.strip()
}
# 来源 IP 白名单：可选，配置后才校验（空则跳过 IP 校验）
#   .env 中 ALLOWED_IPS=223.244.14.237,223.244.14.238
_allowed_ips_raw = _env("ALLOWED_IPS", "")
ALLOWED_IPS: set[str] = {
    s.strip() for s in _allowed_ips_raw.split(",") if s.strip()
}

# ===== 速率限制 =====
RATE_LIMIT_WINDOW = 60       # 速率限制窗口（秒）
RATE_LIMIT_MAX_REQUESTS = 10 # 窗口内每用户最大请求数
RATE_LIMIT_CLEANUP_INTERVAL = 300  # 速率限制字典清理间隔（秒）
RATE_LIMIT_MAX_USERS = 10000  # 速率限制字典最大用户数（兜底保护）

# ===== 调试 =====
# DEBUG=1 时记录 webhook 完整请求头和 body 到日志，用于分析 IM 平台转发特征
# 兼容大小写：DEBUG / debug 均可，值为 1/true/yes 开启
DEBUG = _env("DEBUG", "0").lower() in ("1", "true", "yes")

# ===== 后台任务 =====
CLEANUP_INTERVAL = 300   # 过期会话清理间隔（秒）

# ===== 会话存储 =====
SESSION_TIMEOUT = 0      # 会话超时（秒，0表示永不过期）
MAX_HISTORY_MESSAGES = 20
MAX_CACHE_SIZE = 100
MAX_ADMIN_SESSIONS = 500 # 管理 API 最大返回会话数
MAX_DB_SIZE_BYTES = 5 * 1024 * 1024 * 1024   # 5GB
TARGET_DB_SIZE_BYTES = 4 * 1024 * 1024 * 1024  # 4GB
MAX_USER_LOCKS = 500    # per-user 锁字典最大容量

# ===== 日志 =====
LOG_DIR = "logs"
LOG_FILE = "mixin-chatbot.log"
LOG_MAX_BYTES = 5 * 1024 * 1024   # 5MB
LOG_BACKUP_COUNT = 3

# ===== 群组配置 =====
# 默认 AI 模型（未在 GROUP_CONFIGS 中单独配置的群组使用此模型）
DEFAULT_MODEL = _env("DEFAULT_MODEL", "qwen3.7-plus")
DEFAULT_GROUP_CONFIG = {
    "model": DEFAULT_MODEL,
    "system_prompt": "你是聊天机器人，以纯文本形式回复用户的问题。不要使用任何格式，例如Markdown。",
}

# 从 .env 解析群组配置，格式: GROUP_CONFIGS=群组ID1:模型名1,群组ID2:模型名2
GROUP_CONFIGS = {}
_raw = _env("GROUP_CONFIGS", "")
for _item in _raw.split(","):
    _item = _item.strip()
    if ":" in _item:
        _gid, _model = _item.split(":", 1)
        GROUP_CONFIGS[_gid.strip()] = {"model": _model.strip()}
