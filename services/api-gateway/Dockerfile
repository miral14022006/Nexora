FROM node:22-alpine

# Workspace install: deps are hoisted to /app/node_modules so the shared
# @nexora/verify-jwt package can resolve jsonwebtoken from its real path.
WORKDIR /app

COPY package.json ./
COPY packages/verify-jwt ./packages/verify-jwt
COPY services/api-gateway ./services/api-gateway

# Full install (dev deps included) so `npm test` works inside the container
RUN npm install

WORKDIR /app/services/api-gateway

EXPOSE 3000

CMD ["node", "src/index.js"]
