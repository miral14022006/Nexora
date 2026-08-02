#!/usr/bin/env node
/**
 * Builds every Nexora production image locally with Docker, using the exact
 * same Dockerfile paths/contexts as render.yaml. Fails fast on the first
 * broken build.
 *
 * Usage: node scripts/build-images.mjs
 * Requires a running Docker daemon.
 */
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// { name, context, dockerfile }
const images = [
  ...["api-gateway", "auth-service", "user-service", "group-service", "chat-service", "delivery-service", "presence-service", "notification-service", "media-service", "websocket-gateway"].map((svc) => ({
    name: `nexora-${svc}`,
    context: root,
    dockerfile: join(root, "services", svc, "Dockerfile"),
  })),
  { name: "nexora-frontend", context: join(root, "frontend"), dockerfile: join(root, "frontend", "Dockerfile") },
];

for (const img of images) {
  process.stdout.write(`Building ${img.name} ... `);
  try {
    execFileSync("docker", ["build", "-q", "-t", img.name, "-f", img.dockerfile, img.context], { stdio: ["ignore", "ignore", "inherit"] });
    console.log("OK");
  } catch (e) {
    console.error(`FAILED (exit ${e.status})`);
    process.exit(1);
  }
}
console.log(`\nAll ${images.length} images built.`);
