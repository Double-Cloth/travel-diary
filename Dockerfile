FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    TRAVEL_BROWSER_PATH=/usr/bin/chromium \
    CHROMIUM_FLAGS="--no-sandbox --disable-dev-shm-usage"
# Chromium 复用容器隔离，适配非 root、no-new-privileges 和默认共享内存大小。
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*
# Debian 启动器会重置环境中的 CHROMIUM_FLAGS，参数通过其配置目录读取。
RUN printf 'export CHROMIUM_FLAGS="%s"\n' "$CHROMIUM_FLAGS" > /etc/chromium.d/travel-diary
WORKDIR /opt/travel-diary
COPY --chown=node:node LICENSE package.json index.html travel-diary.config.json travel-diary.config.schema.json ./
COPY --chown=node:node js/ ./js/
COPY --chown=node:node css/ ./css/
COPY --chown=node:node assets/ ./assets/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node deploy/entrypoint.sh /usr/local/bin/travel-diary-entrypoint
RUN mkdir -p /var/lib/travel-diary && chown node:node /var/lib/travel-diary \
    && chmod 755 /usr/local/bin/travel-diary-entrypoint
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/double-cloth-studio/travel-diary" \
      org.opencontainers.image.description="Travel Diary" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${VCS_REF}"
USER node
EXPOSE 9000
STOPSIGNAL SIGTERM
ENTRYPOINT ["travel-diary-entrypoint"]
CMD ["node", "/opt/travel-diary/js/server.js", "--dir", "/var/lib/travel-diary"]
