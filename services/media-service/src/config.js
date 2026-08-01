export const config = {
  port: Number(process.env.PORT ?? 3010),
  serviceName: process.env.SERVICE_NAME ?? "media-service",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://nexora:nexora@localhost:5432/nexora",
  minio: {
    // Internal endpoint: how this service reaches MinIO (compose network DNS).
    // The SAME bucket is reachable from the browser via the published port,
    // which is what the presigned URLs point at (see MINIO_PUBLIC_ENDPOINT).
    endPoint: process.env.MINIO_INTERNAL_ENDPOINT ?? "minio",
    // Public endpoint: host name embedded in presigned URLs. It must be
    // resolvable by the CLIENT (browser), so it is the host-side mapping of
    // the MinIO API port, never the internal DNS name.
    publicEndPoint: process.env.MINIO_PUBLIC_ENDPOINT ?? "localhost",
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
    accessKey: process.env.MINIO_ACCESS_KEY ?? "nexora",
    secretKey: process.env.MINIO_SECRET_KEY ?? "nexora-minio-secret",
    bucket: process.env.MINIO_BUCKET ?? "nexora-media",
  },
};
