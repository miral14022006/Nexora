import http from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();
const server = http.createServer(app);
app.attachWs(server);

server.listen(config.port, () => {
  console.log(`[${config.serviceName}] listening on :${config.port}`);
});
