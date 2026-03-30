import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { initialize } from "../src/storage-connector";
import StorageService from "../src/storage-service";

test("StorageService supports filesystem roundtrips without pkgcloud", async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-storage-service-"));
  const service = new StorageService({
    provider: "filesystem",
    root,
  });

  try {
    await service.createContainer({ name: "docs" });

    const writer = service.uploadStream("docs", "note.txt");
    writer.end("hello world");
    await once(writer, "success");

    const file = await service.getFile("docs", "note.txt")!;
    expect(file.size).toBe(11);

    const files = await service.getFiles("docs")!;
    expect(files.length).toBe(1);
    expect(files[0]?.name).toBe("note.txt");

    const reader = service.downloadStream("docs", "note.txt");
    const chunks: Buffer[] = [];

    reader.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await once(reader, "end");

    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello world");

    await service.removeFile("docs", "note.txt");
    await expect(service.getFile("docs", "note.txt")!).rejects.toBeDefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("StorageService supports nested filesystem paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-storage-service-nested-"));
  const service = new StorageService({
    provider: "filesystem",
    root,
  });

  try {
    await service.createContainer({ name: "docs" });

    const remotePath = "reports/daily/note.txt";
    const writer = service.uploadStream("docs", remotePath);
    writer.end("hello nested world");
    await once(writer, "success");

    const file = await service.getFile("docs", remotePath)!;
    expect(file.name).toBe(remotePath);
    expect(file.size).toBe(18);

    const files = await service.getFiles("docs")!;
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe(remotePath);

    const reader = service.downloadStream("docs", remotePath);
    const chunks: Buffer[] = [];

    reader.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await once(reader, "end");

    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello nested world");

    await service.removeFile("docs", remotePath);
    await expect(service.getFile("docs", remotePath)!).rejects.toBeDefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("connector registers download and downloadSigned with query-friendly routes", () => {
  const dataSource = {
    settings: {
      provider: "filesystem" as const,
      root: "/tmp/lb-storage-metadata",
    },
  };

  initialize(dataSource);

  const download = dataSource.connector?.DataAccessObject?.download as {
    accepts?: unknown[];
    http?:
      | {
          path?: string;
          verb?: string;
        }
      | Array<{
          path?: string;
          verb?: string;
        }>;
    returns?: Record<string, unknown>;
    shared?: boolean;
  };
  const downloadSigned = dataSource.connector?.DataAccessObject?.downloadSigned as {
    accepts?: unknown[];
    http?:
      | {
          path?: string;
          verb?: string;
        }
      | Array<{
          path?: string;
          verb?: string;
        }>;
    returns?: Record<string, unknown>;
    shared?: boolean;
  };

  expect(download).toBeDefined();
  expect(download.shared).toBe(true);
  expect(download.http).toEqual([
    {
      path: "/:container/download",
      verb: "get",
    },
    {
      path: "/:container/download/:file(*)",
      verb: "get",
    },
  ]);
  expect(download.accepts).toHaveLength(4);
  expect(download.returns).toEqual({});

  expect(downloadSigned).toBeDefined();
  expect(downloadSigned.shared).toBe(true);
  expect(downloadSigned.http).toEqual([
    {
      path: "/:container/signed-download",
      verb: "get",
    },
    {
      path: "/:container/signed-download/:file(*)",
      verb: "get",
    },
  ]);
  expect(downloadSigned.accepts).toHaveLength(4);
  expect(downloadSigned.returns).toEqual({});
});
