# syntax=docker/dockerfile:1

# ------------------------------------------------------------------------------
# Nexora presence-service — production image (health-only stub)
# Build context: repository root (dockerContext: ".")
# Workspace deps: none
# ------------------------------------------------------------------------------

# Stage 1 — install production dependencies (workspace-hoisted into /app/node_modules)
FROM node:22-alpine AS deps

ENV NPM_CONFIG_CACHE=/tmp/npm-cache
WORKDIR /app

COPY package.json ./
COPY services/presence-service ./services/presence-service

RUN npm install --omit=dev --no-audit --no-fund

# Stage 2 — minimal runtime image (non-root)
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/presence-service ./services/presence-service

USER node
WORKDIR /app/services/presence-service

EXPOSE 3006

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3006)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
