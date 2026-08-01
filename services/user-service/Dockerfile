FROM node:22-alpine

# Workspace install: deps are hoisted to /app/node_modules so the shared
# @nexora/internal-auth package can resolve its own dependencies.
WORKDIR /app

COPY package.json ./
COPY packages/internal-auth ./packages/internal-auth
COPY services/user-service ./services/user-service

# Full install (dev deps included) so `npm test` works inside the container
RUN npm install

WORKDIR /app/services/user-service

EXPOSE 3002

CMD ["node", "src/index.js"]
