# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the frontend (Vite) -> /build/dist
# ---------------------------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: install the server's production dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist
WORKDIR /app

COPY --from=frontend --chown=root:root /build/dist ./dist
COPY --from=server-deps --chown=root:root /app/server/node_modules ./server/node_modules
COPY --chown=root:root server/package.json server/package-lock.json server/*.js ./server/
COPY --chown=root:root server/login ./server/login

# The app runs as the unprivileged "node" user (uid 1000) shipped with the image;
# only /data is writable for it.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
