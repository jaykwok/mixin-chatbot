# Bun 运行时镜像
FROM oven/bun:1-debian

# 非 root 用户（延续 Python 版的安全约束）
RUN groupadd -r -g 1001 appgroup && \
    useradd -r -u 1001 -g appgroup -m -d /home/appuser -s /bin/bash appuser

WORKDIR /app

# 先装依赖（利用层缓存；.dockerignore 排除本地 node_modules，容器内重装）
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# 拷贝源码
COPY --chown=appuser:appgroup . .

RUN mkdir -p /app/data /app/logs && chown -R appuser:appgroup /app

USER appuser
ENV TZ=Asia/Shanghai

EXPOSE 1011

# 健康检查（bun fetch，无需额外装 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:1011/favicon.svg').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
