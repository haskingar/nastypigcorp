import type { Config } from "../config.js";
import type { StorageProvider } from "./types.js";
import { createLocalDiskStorageProvider } from "./local-disk-provider.js";
import { createS3StorageProvider } from "./s3-provider.js";
import { createVercelBlobStorageProvider } from "./vercel-blob-provider.js";

export function createStorageProviderFromConfig(config: Config): StorageProvider {
  if (config.storageProvider === "local_disk") {
    return createLocalDiskStorageProvider(config.storageLocalDiskBaseDir);
  }

  if (config.storageProvider === "vercel_blob") {
    return createVercelBlobStorageProvider({ token: process.env.BLOB_READ_WRITE_TOKEN });
  }

  return createS3StorageProvider({
    bucket: config.storageS3Bucket,
    region: config.storageS3Region,
    endpoint: config.storageS3Endpoint,
    prefix: config.storageS3Prefix,
    forcePathStyle: config.storageS3ForcePathStyle,
  });
}
