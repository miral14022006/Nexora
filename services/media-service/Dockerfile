FROM node:22-alpine

# Workspace install: deps are hoisted to /app/node_modules so the shared
# @nexora packages can resolve their own dependencies from their real paths.
WORKDIR /app

COPY package.json ./
COPY packages/internal-auth ./packages/internal-auth
COPY services/media-service ./services/media-service

# Full install (dev deps included) so `npm test` works inside the container
RUN npm install

WORKDIR /app/services/media-service

EXPOSE 3010

CMD ["node", "src/index.js"]
