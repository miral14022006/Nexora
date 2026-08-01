FROM node:22-alpine

# Workspace install: deps are hoisted to /app/node_modules so the shared
# @nexora packages can resolve their own dependencies from their real paths.
WORKDIR /app

COPY package.json ./
COPY packages/verify-jwt ./packages/verify-jwt
COPY packages/internal-auth ./packages/internal-auth
COPY services/chat-service ./services/chat-service

# Full install (dev deps included) so `npm test` works inside the container
RUN npm install

WORKDIR /app/services/chat-service

EXPOSE 3004

CMD ["node", "src/index.js"]
