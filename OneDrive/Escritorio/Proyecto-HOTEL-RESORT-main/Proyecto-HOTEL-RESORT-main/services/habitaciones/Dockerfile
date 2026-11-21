FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY services/habitaciones ./services/habitaciones
USER node
ENV NODE_ENV=production HOST=0.0.0.0 HABITACIONES_PORT=3002
EXPOSE 3002
CMD ["node", "services/habitaciones/src/server.js"]