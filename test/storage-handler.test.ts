import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

import { FilesystemProvider } from "../src/providers/filesystem";
import {
  download,
  downloadSigned,
  getSignedUrl,
  upload,
} from "../src/storage-handler";
import type {
  StorageProvider,
  StorageRequest,
  StorageResponse,
  UploadStream,
} from "../src/types";
import {
  createSignedUrlSignature,
} from "../src/utils";

test("upload stores multipart files on the filesystem provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-storage-handler-"));
  const provider = new FilesystemProvider({
    provider: "filesystem",
    root,
  });
  const response = new MockResponse();

  try {
    await provider.createContainer({ name: "docs" });

    const boundary = "----loopback-storage-boundary";
    const request = createRequest(boundary, "docs");
    const uploadPromise = new Promise<UploadResult>((resolve, reject) => {
      upload(provider, request, response, {}, (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result as UploadResult);
      });
    });

    request.end(
      buildMultipartBody(boundary, [
        {
          content: "hello world",
          contentType: "text/plain",
          fieldName: "file",
          filename: "hello.txt",
        },
      ]),
    );

    const result = await uploadPromise;
    const storedFile = result.files.file?.[0];

    expect(storedFile).toBeDefined();
    expect(storedFile?.name).toBe("hello.txt");
    expect(storedFile?.size).toBe(11);
    expect(storedFile).not.toHaveProperty("request");
    expect(storedFile).not.toHaveProperty("response");
    await expect(
      readFile(join(root, "docs", "hello.txt"), "utf8"),
    ).resolves.toBe("hello world");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("upload aborts the request as soon as maxFileSize is exceeded", async () => {
  const boundary = "----loopback-storage-limit";
  const request = createRequest(boundary, "docs");
  const response = new MockResponse();
  let abortedUpload = false;

  const provider = createUploadOnlyProvider(() => {
    const writer = new PassThrough() as UploadStream;
    writer.abortUpload = async () => {
      abortedUpload = true;
      writer.destroy();
    };
    return writer;
  });

  const uploadPromise = new Promise<UploadResult>((resolve, reject) => {
    upload(
      provider,
      request,
      response,
      {
        maxFileSize: 5,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result as UploadResult);
      },
    );
  });

  request.write(
    buildMultipartPreamble(boundary, {
      contentType: "text/plain",
      fieldName: "file",
      filename: "big.txt",
    }),
  );
  request.write("12345");

  await new Promise<void>((resolve) => setImmediate(resolve));

  request.write("6");

  const error = (await uploadPromise.catch((reason) => reason)) as Error & {
    code?: string;
    limit?: number;
    statusCode?: number;
  };

  expect(error.code).toBe("REQUEST_ENTITY_TOO_LARGE");
  expect(error.limit).toBe(5);
  expect(error.statusCode).toBe(413);
  expect(request.destroyed).toBe(true);
  expect(abortedUpload).toBe(true);
});

test("download with signed-url returns a friendly 404 for missing files", async () => {
  const request = createRequest("----unused", "docs");
  request.headers = {};
  request.params.file = "missing.png";
  request.query = {
    "signed-url": true,
  };

  const response = new MockResponse();
  const provider: StorageProvider = {
    config: {
      signedUrl: {
        enabled: true,
        expiresIn: 900,
      },
    },
    createContainer: async () => {
      throw new Error("Not implemented");
    },
    destroyContainer: async () => {
      throw new Error("Not implemented");
    },
    download: () => {
      throw new Error("Not implemented");
    },
    getContainer: async () => {
      throw new Error("Not implemented");
    },
    getContainers: async () => {
      throw new Error("Not implemented");
    },
    getFile: async () => {
      throw new Error("Not implemented");
    },
    getFiles: async () => {
      throw new Error("Not implemented");
    },
    getSignedUrl: async () => {
      throw Object.assign(new Error("The specified key does not exist."), {
        $metadata: {
          httpStatusCode: 404,
        },
        Code: "NoSuchKey",
        name: "NoSuchKey",
      });
    },
    removeFile: async () => {
      throw new Error("Not implemented");
    },
    upload: () => {
      throw new Error("Not implemented");
    },
  };

  const error = await new Promise<Error & {
    code?: string;
    status?: number;
    statusCode?: number;
  }>((resolve, reject) => {
    download(provider, request, response, "docs", "missing.png", (err) => {
      if (err) {
        resolve(err);
        return;
      }

      reject(new Error("Expected download to fail"));
    });
  });

  expect(error.message).toBe("File not found: missing.png");
  expect(error.code).toBe("NoSuchKey");
  expect(error.status).toBe(404);
  expect(error.statusCode).toBe(404);
});

test("s3-style providers can be configured to return local signed URLs", async () => {
  const getSignedUrlMock = vi.fn(async () => "https://s3.example.com/object");
  const getFileMock = vi.fn(async () => ({
    container: "docs",
    name: "reports/daily/summary.json.gz",
    size: 10,
  }));
  const request = createEmptyRequest();
  request.headers = {
    host: "api.example.com",
    "x-forwarded-proto": "https",
  };
  request.params = {
    container: "docs",
  };
  request.query = {
    file: "reports/daily/summary.json.gz",
    "signed-url": true,
    access_token: "secret-token",
  };
  request.url =
    "/docs/download?file=reports%2Fdaily%2Fsummary.json.gz&signed-url=true&access_token=secret-token";

  const response = new MockResponse();
  const provider: StorageProvider = {
    config: {
      signedUrl: {
        enabled: true,
        expiresIn: 900,
        secret: "top-secret",
        strategy: "local",
      },
    },
    createContainer: async () => {
      throw new Error("Not implemented");
    },
    destroyContainer: async () => {
      throw new Error("Not implemented");
    },
    download: () => {
      throw new Error("Not implemented");
    },
    getContainer: async () => {
      throw new Error("Not implemented");
    },
    getContainers: async () => {
      throw new Error("Not implemented");
    },
    getFile: getFileMock,
    getFiles: async () => {
      throw new Error("Not implemented");
    },
    getSignedUrl: getSignedUrlMock,
    removeFile: async () => {
      throw new Error("Not implemented");
    },
    upload: () => {
      throw new Error("Not implemented");
    },
  };

  await new Promise<void>((resolve, reject) => {
    download(provider, request, response, "docs", undefined, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  expect(getFileMock).toHaveBeenCalledWith(
    "docs",
    "reports/daily/summary.json.gz",
  );
  expect(getSignedUrlMock).not.toHaveBeenCalled();
  expect(response.redirectedTo).toBeDefined();
  const redirectUrl = new URL(response.redirectedTo as string);
  expect(redirectUrl.origin).toBe("https://api.example.com");
  expect(redirectUrl.pathname).toBe("/docs/signed-download");
  expect(redirectUrl.searchParams.get("file")).toBe(
    "reports/daily/summary.json.gz",
  );
  expect(redirectUrl.searchParams.get("access_token")).toBeNull();
  expect(redirectUrl.searchParams.get("signature")).toBeTruthy();
  expect(redirectUrl.searchParams.get("expires")).toBeTruthy();
});

test("request signedUrlStrategy overrides datasource strategy", async () => {
  const getSignedUrlMock = vi.fn(async () => "https://s3.example.com/object");
  const getFileMock = vi.fn(async () => ({
    container: "docs",
    name: "reports/daily/summary.json.gz",
    size: 10,
  }));
  const request = createEmptyRequest();
  request.headers = {
    host: "api.example.com",
    "x-forwarded-proto": "https",
  };
  request.params = {
    container: "docs",
  };
  request.query = {
    file: "reports/daily/summary.json.gz",
    "signed-url": true,
    signedUrlStrategy: "local",
  };
  request.url =
    "/docs/download?file=reports%2Fdaily%2Fsummary.json.gz&signed-url=true&signedUrlStrategy=local";

  const response = new MockResponse();
  const provider: StorageProvider = {
    config: {
      signedUrl: {
        enabled: true,
        expiresIn: 900,
        strategy: "provider",
        secret: "top-secret",
      },
    },
    createContainer: async () => {
      throw new Error("Not implemented");
    },
    destroyContainer: async () => {
      throw new Error("Not implemented");
    },
    download: () => {
      throw new Error("Not implemented");
    },
    getContainer: async () => {
      throw new Error("Not implemented");
    },
    getContainers: async () => {
      throw new Error("Not implemented");
    },
    getFile: getFileMock,
    getFiles: async () => {
      throw new Error("Not implemented");
    },
    getSignedUrl: getSignedUrlMock,
    removeFile: async () => {
      throw new Error("Not implemented");
    },
    upload: () => {
      throw new Error("Not implemented");
    },
  };

  await new Promise<void>((resolve, reject) => {
    download(provider, request, response, "docs", undefined, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  expect(getFileMock).toHaveBeenCalledWith(
    "docs",
    "reports/daily/summary.json.gz",
  );
  expect(getSignedUrlMock).not.toHaveBeenCalled();
  expect(response.redirectedTo).toBeDefined();
  const redirectUrl = new URL(response.redirectedTo as string);
  expect(redirectUrl.pathname).toBe("/docs/signed-download");
  expect(redirectUrl.searchParams.get("file")).toBe(
    "reports/daily/summary.json.gz",
  );
});

test("getSignedUrl returns a local signed URL for s3-style providers when configured", async () => {
  const getSignedUrlMock = vi.fn(async () => "https://s3.example.com/object");
  const getFileMock = vi.fn(async () => ({
    container: "docs",
    name: "reports/daily/summary.json.gz",
    size: 10,
  }));
  const request = createEmptyRequest();
  request.headers = {
    host: "api.example.com",
    "x-forwarded-proto": "https",
  };
  request.params = {
    container: "docs",
  };
  request.query = {
    file: "reports/daily/summary.json.gz",
  };
  request.url = "/docs/download?file=reports%2Fdaily%2Fsummary.json.gz";

  const provider: StorageProvider = {
    config: {
      signedUrl: {
        expiresIn: 900,
        secret: "top-secret",
        strategy: "local",
      },
    },
    createContainer: async () => {
      throw new Error("Not implemented");
    },
    destroyContainer: async () => {
      throw new Error("Not implemented");
    },
    download: () => {
      throw new Error("Not implemented");
    },
    getContainer: async () => {
      throw new Error("Not implemented");
    },
    getContainers: async () => {
      throw new Error("Not implemented");
    },
    getFile: getFileMock,
    getFiles: async () => {
      throw new Error("Not implemented");
    },
    getSignedUrl: getSignedUrlMock,
    removeFile: async () => {
      throw new Error("Not implemented");
    },
    upload: () => {
      throw new Error("Not implemented");
    },
  };

  const result = await new Promise<{ url: string } | null>((resolve, reject) => {
    getSignedUrl(provider, request, new MockResponse(), "docs", undefined, (
      error,
      value,
    ) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(value ?? null);
    });
  });

  expect(getFileMock).toHaveBeenCalledWith(
    "docs",
    "reports/daily/summary.json.gz",
  );
  expect(getSignedUrlMock).not.toHaveBeenCalled();
  expect(result?.url).toBeDefined();
  const redirectUrl = new URL(result?.url as string);
  expect(redirectUrl.pathname).toBe("/docs/signed-download");
  expect(redirectUrl.searchParams.get("file")).toBe(
    "reports/daily/summary.json.gz",
  );
});

test("explicit getSignedUrl options override datasource strategy", async () => {
  const getSignedUrlMock = vi.fn(async () => "https://s3.example.com/object");
  const request = createEmptyRequest();
  request.headers = {
    host: "api.example.com",
    "x-forwarded-proto": "https",
  };
  request.params = {
    container: "docs",
  };
  request.query = {
    file: "reports/daily/summary.json.gz",
    signedUrlStrategy: "local",
  };
  request.url =
    "/docs/download?file=reports%2Fdaily%2Fsummary.json.gz&signedUrlStrategy=local";

  const provider: StorageProvider = {
    config: {
      signedUrl: {
        expiresIn: 900,
        secret: "top-secret",
        strategy: "local",
      },
    },
    createContainer: async () => {
      throw new Error("Not implemented");
    },
    destroyContainer: async () => {
      throw new Error("Not implemented");
    },
    download: () => {
      throw new Error("Not implemented");
    },
    getContainer: async () => {
      throw new Error("Not implemented");
    },
    getContainers: async () => {
      throw new Error("Not implemented");
    },
    getFile: async () => {
      throw new Error("Should not validate local URL path when strategy is forced to provider");
    },
    getFiles: async () => {
      throw new Error("Not implemented");
    },
    getSignedUrl: getSignedUrlMock,
    removeFile: async () => {
      throw new Error("Not implemented");
    },
    upload: () => {
      throw new Error("Not implemented");
    },
  };

  const result = await new Promise<{ url: string } | null>((resolve, reject) => {
    getSignedUrl(
      provider,
      request,
      new MockResponse(),
      "docs",
      undefined,
      (error, value) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(value ?? null);
      },
      { strategy: "provider" },
    );
  });

  expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ url: "https://s3.example.com/object" });
});

test("filesystem signed-url redirects to a local signed download URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-storage-signed-url-"));
  const provider = new FilesystemProvider({
    provider: "filesystem",
    root,
    signedUrl: {
      enabled: true,
      expiresIn: 120,
      secret: "top-secret",
    },
  });

  try {
    await provider.createContainer({ name: "docs" });
    await writeFile(join(root, "docs", "hello.txt"), "hello");

    const request = createRequest("----unused", "docs");
    request.headers = {
      host: "storage.example.com",
      "x-forwarded-proto": "https",
    };
    request.params.file = "hello.txt";
    request.query = {
      api_key: "secret-api-key",
      "signed-url": true,
      access_token: "abc123",
      preview: "1",
      session_id: "session-secret",
      uploadToken: "upload-secret",
    };
    request.url =
      "/docs/download/hello.txt?signed-url=true&access_token=abc123&uploadToken=upload-secret&api_key=secret-api-key&session_id=session-secret&preview=1";
    const response = new MockResponse();

    await new Promise<void>((resolve, reject) => {
      download(provider, request, response, "docs", "hello.txt", (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    expect(response.redirectedTo).toBeDefined();
    const redirectUrl = new URL(response.redirectedTo as string);

    expect(redirectUrl.origin).toBe("https://storage.example.com");
    expect(redirectUrl.pathname).toBe("/docs/signed-download");
    expect(redirectUrl.searchParams.get("api_key")).toBeNull();
    expect(redirectUrl.searchParams.get("signed-url")).toBeNull();
    expect(redirectUrl.searchParams.get("access_token")).toBeNull();
    expect(redirectUrl.searchParams.get("session_id")).toBeNull();
    expect(redirectUrl.searchParams.get("uploadToken")).toBeNull();
    expect(redirectUrl.searchParams.get("file")).toBe("hello.txt");
    expect(redirectUrl.searchParams.get("preview")).toBe("1");
    expect(redirectUrl.searchParams.get("signature")).toBeTruthy();
    expect(redirectUrl.searchParams.get("expires")).toBeTruthy();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem signed-url download succeeds when signature is valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-storage-signed-download-"));
  const provider = new FilesystemProvider({
    provider: "filesystem",
    root,
    signedUrl: {
      enabled: true,
      secret: "top-secret",
    },
  });

  try {
    await provider.createContainer({ name: "docs" });
    await writeFile(join(root, "docs", "hello.txt"), "hello world");

    const expires = String(Math.floor(Date.now() / 1000) + 60);
    const request = createRequest("----unused", "docs");
    request.headers = {};
    request.params.file = "hello.txt";
    request.query = {
      expires,
      signature: createSignedUrlSignature(
        "top-secret",
        "docs",
        "hello.txt",
        Number(expires),
      ),
    };
    request.url = `/docs/download/hello.txt?expires=${expires}`;
    const response = new MockResponse();
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    await new Promise<void>((resolve, reject) => {
      downloadSigned(provider, request, response, "docs", "hello.txt", (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello world");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("download supports resolving the file from a query parameter", async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-storage-query-download-"));
  const provider = new FilesystemProvider({
    provider: "filesystem",
    root,
  });

  try {
    await provider.createContainer({ name: "docs" });
    await mkdir(join(root, "docs", "reports", "daily"), { recursive: true });
    await writeFile(
      join(root, "docs", "reports", "daily", "summary.json.gz"),
      "compressed payload",
    );

    const remote = "reports/daily/summary.json.gz";
    const request = createEmptyRequest();
    request.headers = {};
    request.params = {
      container: "docs",
    };
    request.query = {
      file: remote,
    };
    request.url = `/docs/download?file=${encodeURIComponent(remote)}`;
    const response = new MockResponse();
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    await new Promise<void>((resolve, reject) => {
      download(provider, request, response, "docs", undefined, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    expect(response.contentType).toBe("summary.json.gz");
    expect(Buffer.concat(chunks).toString("utf8")).toBe("compressed payload");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem signed-url download supports nested files and wildcard params", async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-storage-nested-signed-download-"));
  const provider = new FilesystemProvider({
    provider: "filesystem",
    root,
    signedUrl: {
      enabled: true,
      secret: "top-secret",
    },
  });

  try {
    await provider.createContainer({ name: "docs" });
    await mkdir(join(root, "docs", "reports", "daily"), { recursive: true });
    await writeFile(
      join(root, "docs", "reports", "daily", "summary.json.gz"),
      "compressed payload",
    );

    const remote = "reports/daily/summary.json.gz";
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    const request = createEmptyRequest();
    request.headers = {};
    request.params = {
      container: "docs",
    };
    request.query = {
      expires,
      file: remote,
      signature: createSignedUrlSignature(
        "top-secret",
        "docs",
        remote,
        Number(expires),
      ),
    };
    request.url = `/docs/signed-download?file=${encodeURIComponent(remote)}&expires=${expires}`;
    const response = new MockResponse();
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    await new Promise<void>((resolve, reject) => {
      downloadSigned(provider, request, response, "docs", undefined, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    expect(response.contentType).toBe("summary.json.gz");
    expect(Buffer.concat(chunks).toString("utf8")).toBe("compressed payload");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem signed-url download fails when signature is invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-storage-invalid-signed-url-"));
  const provider = new FilesystemProvider({
    provider: "filesystem",
    root,
    signedUrl: {
      enabled: true,
      secret: "top-secret",
    },
  });

  try {
    await provider.createContainer({ name: "docs" });
    await writeFile(join(root, "docs", "hello.txt"), "hello world");

    const request = createRequest("----unused", "docs");
    request.headers = {};
    request.params.file = "hello.txt";
    request.query = {
      expires: String(Math.floor(Date.now() / 1000) + 60),
      signature: "invalid",
    };
    const response = new MockResponse();

    const error = await new Promise<Error & {
      code?: string;
      status?: number;
      statusCode?: number;
    }>((resolve, reject) => {
      downloadSigned(provider, request, response, "docs", "hello.txt", (err) => {
        if (err) {
          resolve(err);
          return;
        }

        reject(new Error("Expected download to fail"));
      });
    });

    expect(error.code).toBe("INVALID_SIGNED_URL");
    expect(error.status).toBe(403);
    expect(error.statusCode).toBe(403);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("filesystem provider generates signed URLs for custom routes and nested remotes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-storage-custom-signed-url-"));
  const provider = new FilesystemProvider({
    provider: "filesystem",
    root,
    signedUrl: {
      enabled: true,
      secret: "top-secret",
    },
  });

  try {
    await provider.createContainer({ name: "customer-1" });
    await mkdir(
      join(root, "customer-1", "projects", "project-1", "event-summaries"),
      { recursive: true },
    );
    await writeFile(
      join(
        root,
        "customer-1",
        "projects",
        "project-1",
        "event-summaries",
        "2026-03-29.json.gz",
      ),
      "payload",
    );

    const request = createEmptyRequest();
    request.headers = {
      host: "api.example.com",
      "x-forwarded-proto": "https",
    };
    request.params = {
      id: "customer-1",
      nk: "project-1",
    };
    request.query = {
      access_token: "secret-token",
      date: "2026-03-29",
      "signed-url": true,
    };
    request.url =
      "/Customers/customer-1/projects/project-1/eventSummariesBySubject?date=2026-03-29&signed-url=true&access_token=secret-token";

    const url = await provider.getSignedUrl({
      container: "customer-1",
      remote: "projects/project-1/event-summaries/2026-03-29.json.gz",
      request,
    });

    expect(url).toBeDefined();
    const redirectUrl = new URL(url as string);

    expect(redirectUrl.origin).toBe("https://api.example.com");
    expect(redirectUrl.pathname).toBe(
      "/Customers/customer-1/projects/project-1/eventSummariesBySubject/signed-download",
    );
    expect(redirectUrl.searchParams.get("date")).toBe("2026-03-29");
    expect(redirectUrl.searchParams.get("access_token")).toBeNull();
    expect(redirectUrl.searchParams.get("file")).toBe(
      "projects/project-1/event-summaries/2026-03-29.json.gz",
    );
    expect(redirectUrl.searchParams.get("signed-url")).toBeNull();
    expect(redirectUrl.searchParams.get("signature")).toBeTruthy();
    expect(redirectUrl.searchParams.get("expires")).toBeTruthy();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

type MultipartFile = {
  content: string;
  contentType: string;
  fieldName: string;
  filename: string;
};

type UploadResult = {
  fields: Record<string, string[]>;
  files: Record<string, Array<{ name: string; size?: number }>>;
};

class MockResponse extends PassThrough implements StorageResponse {
  readonly headers = new Map<string, string>();
  redirectedTo?: string;
  statusCode?: number;
  contentType?: string;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  set(field: string, value: string | number) {
    this.headers.set(field, String(value));
    return this;
  }

  redirect(url: string) {
    this.redirectedTo = url;
    return this;
  }

  type(value: string) {
    this.contentType = value;
    return this;
  }
}

type MockRequest = PassThrough & StorageRequest;

function createRequest(boundary: string, container: string): MockRequest {
  const request = createEmptyRequest();
  request.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
  request.method = "POST";
  request.params = { container };
  request.query = {};
  request.url = `/${container}/upload`;
  return request;
}

function createEmptyRequest(): MockRequest {
  const request = new PassThrough() as unknown as MockRequest;
  request.headers = {};
  request.params = {};
  request.query = {};
  return request;
}

function buildMultipartBody(boundary: string, files: MultipartFile[]): Buffer {
  const body = files
    .map(
      (file) => `${buildMultipartPreamble(boundary, file)}${file.content}\r\n`,
    )
    .join("");

  return Buffer.from(`${body}--${boundary}--\r\n`);
}

function buildMultipartPreamble(
  boundary: string,
  file: Omit<MultipartFile, "content">,
): string {
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"`,
    `Content-Type: ${file.contentType}`,
    "",
    "",
  ].join("\r\n");
}

function createUploadOnlyProvider(
  createWriter: () => UploadStream,
): StorageProvider {
  return {
    createContainer: async () => {
      throw new Error("Not implemented");
    },
    destroyContainer: async () => {
      throw new Error("Not implemented");
    },
    download: () => {
      throw new Error("Not implemented");
    },
    getContainer: async () => {
      throw new Error("Not implemented");
    },
    getContainers: async () => {
      throw new Error("Not implemented");
    },
    getFile: async () => {
      throw new Error("Not implemented");
    },
    getFiles: async () => {
      throw new Error("Not implemented");
    },
    removeFile: async () => {
      throw new Error("Not implemented");
    },
    upload: () => createWriter(),
  };
}
