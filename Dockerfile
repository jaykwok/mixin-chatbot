# Bun 运行时镜像
FROM ghcr.io/astral-sh/uv:0.11.29 AS uv
FROM oven/bun:1.4.0-debian
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python
COPY scripts/runtime/requirements.in scripts/runtime/requirements.txt scripts/runtime/document-manifest.ts /opt/doc-requirements/
RUN uv venv --python 3.12.13 /app/.venv && \
    uv pip sync --python /app/.venv/bin/python /opt/doc-requirements/requirements.txt && \
    bun /opt/doc-requirements/document-manifest.ts /opt/doc-requirements/requirements.in /app/.venv

# 非 root 运行用户
RUN groupadd -r -g 1001 appgroup && \
    useradd -r -u 1001 -g appgroup -m -d /home/appuser -s /bin/bash appuser

WORKDIR /app

# 先装依赖（利用层缓存；.dockerignore 排除本地 node_modules，容器内重装）
COPY package.json bun.lock ./
COPY scripts/patches ./scripts/patches
RUN bun install --frozen-lockfile --production

# Explicit build inputs prevent local credentials and tool workspaces entering image layers.
COPY --chown=appuser:appgroup src ./src
COPY --chown=appuser:appgroup public ./public
COPY --chown=appuser:appgroup scripts/config ./scripts/config
COPY --chown=appuser:appgroup scripts/ops/*.ts ./scripts/ops/
COPY --chown=appuser:appgroup scripts/lib/*.ts ./scripts/lib/
COPY --chown=appuser:appgroup scripts/runtime ./scripts/runtime
COPY --chown=appuser:appgroup scripts/test.ts ./scripts/test.ts

RUN mkdir -p \
      /app/data/config \
      /app/data/state \
      /app/data/runtime/pi \
      /app/data/groups \
      /app/agents/temp \
      /app/agents/rm \
      /app/logs && \
    chown -R appuser:appgroup /app

USER appuser
ENV TZ=Asia/Shanghai

# 健康检查（bun fetch，无需额外装 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const {PORT}=await import('./src/core/config.ts'); fetch('http://127.0.0.1:'+PORT+'/health').then(r=>r.json()).then(r=>process.exit(r.status==='ready'?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/server/index.ts"]
