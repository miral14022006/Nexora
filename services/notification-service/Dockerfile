FROM node:22-alpine

# Workspace install: deps are hoisted to /app/node_modules (matches the
# chat-service / delivery-service / websocket-gateway image pattern).
WORKDIR /app

COPY package.json ./
COPY services/notification-service ./services/notification-service

# Full install (dev deps included) so `npm test` works inside the container
RUN npm install

WORKDIR /app/services/notification-service

EXPOSE 3007

CMD ["node", "src/index.js"]
