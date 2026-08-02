# syntax=docker/dockerfile:1

# ------------------------------------------------------------------------------
# Nexora frontend — production image (Vite SPA served by nginx)
# Build context: ./frontend (dockerContext: "./frontend")
#
# Runtime networking:
#   Primary:   VITE_API_BASE_URL is baked into the bundle at build time
#              (the api-gateway's PUBLIC url, e.g. https://api-gateway-xxxx.onrender.com).
#              When empty (default), the SPA uses relative /api + /ws paths.
#   Fallback:  nginx proxies relative /api + /ws to the api-gateway. The
#              upstream host:port are injected at container start by the
#              official nginx envsubst template runner — Render sets
#              API_GATEWAY_UPSTREAM via fromService hostport; local
#              docker-compose uses the baked default (api-gateway:3000).
# ------------------------------------------------------------------------------

# Stage 1 — build the SPA
FROM node:22-alpine AS build

ENV NPM_CONFIG_CACHE=/tmp/npm-cache
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Render injects the api-gateway public URL here (optional; relative paths work
# when omitted because nginx proxies /api and /ws to the gateway internally).
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build

# Stage 2 — nginx runtime
FROM nginx:1.27-alpine AS runtime

# Local docker-compose default (compose service DNS). Render overrides this via
# fromService env var on the nexora-frontend service.
ENV API_GATEWAY_UPSTREAM=api-gateway:3000

# Template is rendered by the official nginx entrypoint (envsubst) into
# /etc/nginx/conf.d/default.conf on container start.
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
