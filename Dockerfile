FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /opt/travel-diary
COPY --chown=node:node LICENSE package.json index.html travel-diary.config.json travel-diary.config.schema.json ./
COPY --chown=node:node js/ ./js/
COPY --chown=node:node css/ ./css/
COPY --chown=node:node assets/ ./assets/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node deploy/entrypoint.sh /usr/local/bin/travel-diary-entrypoint
RUN mkdir -p /var/lib/travel-diary && chown node:node /var/lib/travel-diary \
    && chmod 755 /usr/local/bin/travel-diary-entrypoint
USER node
EXPOSE 9000
STOPSIGNAL SIGTERM
ENTRYPOINT ["travel-diary-entrypoint"]
CMD ["node", "/opt/travel-diary/js/server.js", "--dir", "/var/lib/travel-diary"]
