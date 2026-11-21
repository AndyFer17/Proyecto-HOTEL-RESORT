FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY services/shared ./services/shared
COPY services/reservas ./services/reservas
COPY scripts/migrate-service.mjs ./scripts/migrate-service.mjs
USER node
ENV NODE_ENV=production HOST=0.0.0.0 RESERVAS_PORT=3003
EXPOSE 3003
CMD ["node", "services/reservas/src/server.js"]
