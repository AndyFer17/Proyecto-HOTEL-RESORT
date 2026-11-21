FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY services/shared ./services/shared
COPY services/pagos-notificaciones ./services/pagos-notificaciones
COPY scripts/migrate-service.mjs ./scripts/migrate-service.mjs
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PAGOS_PORT=3004
EXPOSE 3004
CMD ["node", "services/pagos-notificaciones/src/server.js"]
