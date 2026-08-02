# syntax=docker/dockerfile:1

# ------------------------------------------------------------------------------
# Nexora media-service — production image
# Build context: repository root (dockerContext: ".")
# Workspace deps: @nexora/internal-auth (imported by src/routes/media.js; resolved
# via workspace hoisting — declared by sibling workspaces).
# ------------------------------------------------------------------------------

# Stage 1 — install production dependencies (workspace-hoisted into /app/node_modules)
FROM node:22-alpine AS deps

ENV NPM_CONFIG_CACHE=/tmp/npm-cache
WORKDIR /app

COPY package.json ./
COPY packages/internal-auth ./packages/internal-auth
COPY services/media-service ./services/media-service

RUN npm install --omit=dev --no-audit --no-fund

# Stage 2 — minimal runtime image (non-root)
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/internal-auth ./packages/internal-auth
COPY --from=deps /app/services/media-service ./services/media-service

USER node
WORKDIR /app/services/media-service

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
