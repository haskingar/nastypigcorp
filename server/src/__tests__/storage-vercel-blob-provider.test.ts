import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => {
  class BlobNotFoundError extends Error {}
  return {
    BlobNotFoundError,
    put: vi.fn(),
    get: vi.fn(),
    head: vi.fn(),
    del: vi.fn(),
  };
});

vi.mock("@vercel/blob", () => blob);

const { createVercelBlobStorageProvider } = await import("../storage/vercel-blob-provider.js");

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("vercel blob storage provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores every object privately under its exact key", async () => {
    const provider = createVercelBlobStorageProvider({ token: "rw-token" });
    await provider.putObject({
      objectKey: "company-1/files/a.txt",
      body: Buffer.from("hello"),
      contentType: "text/plain",
      contentLength: 5,
    });

    expect(provider.id).toBe("vercel_blob");
    expect(blob.put).toHaveBeenCalledWith("company-1/files/a.txt", Buffer.from("hello"), {
      access: "private",
      token: "rw-token",
      contentType: "text/plain",
      addRandomSuffix: false,
      allowOverwrite: true,
      multipart: false,
    });
  });

  it("streams objects back and forwards byte ranges", async () => {
    blob.get.mockResolvedValue({
      statusCode: 200,
      stream: new Blob(["ell"]).stream(),
      headers: new Headers(),
      blob: { contentType: "text/plain", size: 5, etag: "etag-1", uploadedAt: new Date(0) },
    });
    const provider = createVercelBlobStorageProvider();

    const result = await provider.getObject({ objectKey: "company-1/a.txt", range: { start: 1, end: 3 } });

    expect(blob.get).toHaveBeenCalledWith("company-1/a.txt", expect.objectContaining({
      access: "private",
      useCache: false,
      headers: { Range: "bytes=1-3" },
    }));
    expect(result.contentLength).toBe(3);
    expect(result.etag).toBe("etag-1");
    expect(await readAll(result.stream)).toBe("ell");
  });

  it("maps a missing object to a 404 on read and exists=false on head", async () => {
    blob.get.mockResolvedValue(null);
    blob.head.mockRejectedValue(new blob.BlobNotFoundError("missing"));
    const provider = createVercelBlobStorageProvider();

    await expect(provider.getObject({ objectKey: "company-1/missing" })).rejects.toMatchObject({ status: 404 });
    await expect(provider.headObject({ objectKey: "company-1/missing" })).resolves.toEqual({ exists: false });
  });

  it("rethrows head failures other than not-found", async () => {
    blob.head.mockRejectedValue(new Error("store unavailable"));
    const provider = createVercelBlobStorageProvider();

    await expect(provider.headObject({ objectKey: "company-1/a.txt" })).rejects.toThrow("store unavailable");
  });
});
