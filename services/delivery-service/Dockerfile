FROM node:22-alpine

# Workspace install: deps are hoisted to /app/node_modules (matches the
# chat-service / websocket-gateway image pattern).
WORKDIR /app

COPY package.json ./
COPY services/delivery-service ./services/delivery-service

# Full install (dev deps included) so `npm test` works inside the container
RUN npm install

WORKDIR /app/services/delivery-service

EXPOSE 3005

CMD ["node", "src/index.js"]
