# Bun 运行时镜像
FROM ghcr.io/astral-sh/uv:0.11.29 AS uv
FROM docker:29.1.3-cli AS docker_cli
FROM oven/bun:1.4.4-debian
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-impress fonts-noto-cjk fonts-liberation && \
    rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker
ENV UV_PYTHON_INSTALL_DIR=/opt/python
COPY pyproject.toml uv.lock .python-version /opt/doc-environment/
COPY scripts/runtime/document-manifest.ts /opt/doc-environment/document-manifest.ts
RUN UV_PROJECT_ENVIRONMENT=/app/.venv uv sync --locked --no-dev --no-install-project --project /opt/doc-environment && \
    bun /opt/doc-environment/document-manifest.ts /opt/doc-environment /app/.venv

# 非 root 运行用户
RUN groupadd -r -g 1001 appgroup && \
    useradd -r -u 1001 -g appgroup -m -d /home/appuser -s /bin/bash appuser

WORKDIR /app

# 先装依赖（利用层缓存；.dockerignore 排除本地 node_modules，容器内重装）
COPY package.json bun.lock ./
COPY pyproject.toml uv.lock .python-version ./
COPY scripts/patches ./scripts/patches
RUN bun install --frozen-lockfile --production

# Explicit build inputs prevent local credentials and tool workspaces entering image layers.
COPY --chown=appuser:appgroup src ./src
COPY --chown=appuser:appgroup scripts/config ./scripts/config
COPY --chown=appuser:appgroup scripts/ops/*.ts ./scripts/ops/
COPY --chown=appuser:appgroup scripts/lib/*.ts ./scripts/lib/
COPY --chown=appuser:appgroup scripts/runtime ./scripts/runtime
COPY --chown=appuser:appgroup scripts/test.ts ./scripts/test.ts

RUN mkdir -p \
      /app/data/config \
      /app/data/state \
      /app/data/runtime/pi \
      /app/data/workspace \
      /app/data/runtime/tmp \
      /app/backup/snapshots \
      /app/backup/rm \
      /app/tmp \
      /app/logs && \
    chown -R appuser:appgroup /app

USER appuser
ENV TZ=Asia/Shanghai

# 构建标识（构建所用的提交，工作区有改动时带 -dirty）；放在最后，不影响前面各层的缓存。
ARG APP_BUILD=""
ENV APP_BUILD=$APP_BUILD

# 健康检查（bun fetch，无需额外装 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun run scripts/ops/health-check.ts

CMD ["bun", "run", "src/server/index.ts"]
