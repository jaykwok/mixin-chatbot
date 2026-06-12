# 构建阶段（不再需要 build-essential，无 gevent 编译）
FROM python:3.13-slim AS builder

WORKDIR /app

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir -r requirements.txt


# ---- Final Image ----
FROM python:3.13-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

RUN groupadd -r appgroup -g 1001 && \
    useradd -r -u 1001 -g appgroup -m -d /home/appuser -s /bin/bash appuser

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv

# .dockerignore 已排除 .git/.vscode/.venv/logs/data 等
COPY --chown=appuser:appgroup . .

RUN mkdir -p /app/data /app/logs && \
    chown -R appuser:appgroup /app

USER appuser

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV TZ=Asia/Shanghai
ENV PYTHONPATH=/app

EXPOSE 1011

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:1011/favicon.ico || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "1011", "--workers", "1", "--log-level", "warning"]
