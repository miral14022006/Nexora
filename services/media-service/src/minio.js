import { Client } from "minio";
import { config } from "./config.js";

// Two clients for one bucket:
//  - internalClient talks to MinIO over the compose network (stat, remove).
//  - publicClient only ever presigns URLs. Presigned URLs embed the client's
//    endpoint, so this one must be the BROWSER-reachable address (host-side
//    port mapping), otherwise the SPA would get "minio:9000" URLs it can't
//    resolve.
function buildClient(endPoint) {
  return new Client({
    endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
    // Explicit region: the SDK skips the bucket-region lookup network call
    // (which would go to the endpoint — localhost from inside a container —
    // and fail). MinIO defaults to us-east-1.
    region: "us-east-1",
  });
}

export const internalClient = buildClient(config.minio.endPoint);
export const publicClient = buildClient(config.minio.publicEndPoint);

export async function ensureBucket() {
  const exists = await internalClient.bucketExists(config.minio.bucket);
  if (!exists) {
    await internalClient.makeBucket(config.minio.bucket);
    console.log(`[${config.serviceName}] created bucket "${config.minio.bucket}"`);
  }
}
