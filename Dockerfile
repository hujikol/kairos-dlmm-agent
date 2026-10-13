FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY user-config.example.json ./user-config.example.json
COPY profiles/ ./profiles/
COPY scripts/container-start.js ./scripts/container-start.js
RUN mkdir -p /data /app/logs && chown -R node:node /data /app/logs
USER node
EXPOSE 3030
CMD ["node", "scripts/container-start.js"]
