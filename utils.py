import os
import logging
from logging.handlers import RotatingFileHandler
from config import LOG_DIR, LOG_FILE, LOG_MAX_BYTES, LOG_BACKUP_COUNT


def setup_logging():
    """配置日志"""
    os.makedirs(LOG_DIR, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.StreamHandler(),
            RotatingFileHandler(
                os.path.join(LOG_DIR, LOG_FILE),
                maxBytes=LOG_MAX_BYTES,
                backupCount=LOG_BACKUP_COUNT,
                encoding="utf-8",
            ),
        ],
    )
