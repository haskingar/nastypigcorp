import { BlobNotFoundError, del, get, head, put } from "@vercel/blob";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { StorageProvider, GetObjectResult, HeadObjectResult } from "./types.js";
import { notFound } from "../errors.js";

interface VercelBlobProviderConfig {
  /** Falls back to BLOB_READ_WRITE_TOKEN (or Vercel OIDC) inside the SDK. */
  token?: string;
}

// Company files are never public: every object is stored with private access
// and read back through the server, which enforces company scoping.
const ACCESS = "private" as const;

export function createVercelBlobStorageProvider(config: VercelBlobProviderConfig = {}): StorageProvider {
  const token = config.token?.trim() || undefined;

  return {
    id: "vercel_blob",

    async putObject(input) {
      await put(input.objectKey, input.body, {
        access: ACCESS,
        token,
        contentType: input.contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
        multipart: input.contentLength > 16 * 1024 * 1024,
      });
    },

    async getObject(input): Promise<GetObjectResult> {
      const result = await get(input.objectKey, {
        access: ACCESS,
        token,
        useCache: false,
        abortSignal: input.signal,
        headers: input.range ? { Range: `bytes=${input.range.start}-${input.range.end}` } : undefined,
      });
      if (!result || result.statusCode !== 200) throw notFound("Object not found");
      const contentLength = input.range
        ? input.range.end - input.range.start + 1
        : result.blob.size;
      return {
        stream: Readable.fromWeb(result.stream as unknown as NodeWebReadableStream<Uint8Array>),
        contentType: result.blob.contentType || undefined,
        contentLength,
        etag: result.blob.etag,
        lastModified: result.blob.uploadedAt,
      };
    },

    async headObject(input): Promise<HeadObjectResult> {
      try {
        const blob = await head(input.objectKey, { token, abortSignal: input.signal });
        return {
          exists: true,
          contentType: blob.contentType || undefined,
          contentLength: blob.size,
          etag: blob.etag,
          lastModified: blob.uploadedAt,
        };
      } catch (err) {
        if (err instanceof BlobNotFoundError) return { exists: false };
        throw err;
      }
    },

    async deleteObject(input) {
      await del(input.objectKey, { token, abortSignal: input.signal });
    },
  };
}
