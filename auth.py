import hmac
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from config import APP_USERNAME, APP_PASSWORD

security = HTTPBasic()


async def verify_auth(
    credentials: HTTPBasicCredentials = Depends(security),
):
    """验证 Basic Auth（常量时间比较，防止时序攻击）"""
    username_correct = hmac.compare_digest(
        credentials.username.encode("utf-8"), APP_USERNAME.encode("utf-8")
    )
    password_correct = hmac.compare_digest(
        credentials.password.encode("utf-8"), APP_PASSWORD.encode("utf-8")
    )
    if not (username_correct and password_correct):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="认证失败",
            headers={"WWW-Authenticate": "Basic"},
        )
    return credentials.username
