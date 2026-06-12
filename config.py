import os
from dotenv import load_dotenv

load_dotenv()

# ===== 密钥 (from .env) =====
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY")
APP_USERNAME = os.getenv("APP_USERNAME")
APP_PASSWORD = os.getenv("APP_PASSWORD")

# 启动校验
_required = {"DASHSCOPE_API_KEY": DASHSCOPE_API_KEY, "APP_USERNAME": APP_USERNAME, "APP_PASSWORD": APP_PASSWORD}
_missing = [k for k, v in _required.items() if not v]
if _missing:
    raise RuntimeError(f"缺少必要环境变量: {', '.join(_missing)}")

# ===== AI 服务 =====
AI_BASE_URL = os.getenv("AI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
AI_TIMEOUT = 60.0
AI_MAX_RETRIES = 1

# ===== IM 服务 =====
IM_TIMEOUT = 10.0
IM_RETRY_COUNT = 2      # 总尝试次数（首次 + 1次重试）
IM_RETRY_DELAY = 2      # 重试间隔（秒）

# ===== Webhook =====
VALID_HOSTNAMES = {"imtwo.zdxlz.com", "im.zdxlz.com"}
REQUIRED_WEBHOOK_FIELDS = ["type", "textMsg", "phone", "groupId", "callBackUrl"]
DEDUP_TTL = 30           # 请求去重窗口（秒）
MAX_DEDUP_SIZE = 1000    # 去重字典最大容量

# ===== 后台任务 =====
CLEANUP_INTERVAL = 300   # 过期会话清理间隔（秒）

# ===== 会话存储 =====
SESSION_TIMEOUT = 0      # 会话超时（秒，0表示永不过期）
MAX_HISTORY_MESSAGES = 20
MAX_CACHE_SIZE = 100
MAX_ADMIN_SESSIONS = 500 # 管理 API 最大返回会话数
MAX_DB_SIZE_BYTES = 5 * 1024 * 1024 * 1024   # 5GB
TARGET_DB_SIZE_BYTES = 4 * 1024 * 1024 * 1024  # 4GB

# ===== 日志 =====
LOG_DIR = "logs"
LOG_FILE = "chatbot.log"
LOG_MAX_BYTES = 5 * 1024 * 1024   # 5MB
LOG_BACKUP_COUNT = 3

# ===== 群组配置 =====
DEFAULT_GROUP_CONFIG = {
    "model": "kimi-k2.5",
    "system_prompt": "你是聊天机器人，以纯文本形式回复用户的问题。不要使用任何格式，例如Markdown。",
}

# 从 .env 解析群组配置，格式: GROUP_CONFIGS=群组ID1:模型名1,群组ID2:模型名2
GROUP_CONFIGS = {}
_raw = os.getenv("GROUP_CONFIGS", "")
for _pair in _raw.split(","):
    _pair = _pair.strip()
    if ":" in _pair:
        _gid, _model = _pair.split(":", 1)
        GROUP_CONFIGS[_gid.strip()] = {"model": _model.strip()}
