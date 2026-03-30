import { vi, afterEach, expect, test } from "vitest";

const { getSignedUrlMock } = vi.hoisted(() => ({
  getSignedUrlMock: vi.fn(async () => "https://example.com/download"),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import { S3Provider } from "../src/providers/s3";

afterEach(() => {
  getSignedUrlMock.mockClear();
});

test("getSignedUrl validates object existence before signing by default", async () => {
  const provider = new S3Provider({
    provider: "s3",
    region: "us-east-1",
  });
  const send = vi.fn(async () => ({}));

  (provider as unknown as { client: { send: typeof send } }).client = { send };

  const url = await provider.getSignedUrl({
    container: "docs",
    remote: "hello.txt",
  });

  expect(url).toBe("https://example.com/download");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
});

test("getSignedUrl can skip validation before signing", async () => {
  const provider = new S3Provider({
    provider: "s3",
    region: "us-east-1",
    signedUrl: {
      validateBeforeSign: false,
    },
  });
  const send = vi.fn(async () => ({}));

  (provider as unknown as { client: { send: typeof send } }).client = { send };

  const url = await provider.getSignedUrl({
    container: "docs",
    remote: "hello.txt",
  });

  expect(url).toBe("https://example.com/download");
  expect(send).not.toHaveBeenCalled();
  expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
});

test("getSignedUrl forwards response header overrides to the presigned request", async () => {
  const provider = new S3Provider({
    provider: "s3",
    region: "us-east-1",
  });
  const send = vi.fn(async () => ({}));

  (provider as unknown as { client: { send: typeof send } }).client = { send };

  await provider.getSignedUrl({
    container: "docs",
    remote: "reports/daily/summary.json.gz",
    responseCacheControl: "public, max-age=600",
    responseContentEncoding: "gzip",
    responseContentType: "application/json",
  });

  const signedCommand = getSignedUrlMock.mock.calls[0]?.[1];
  expect(signedCommand).toBeInstanceOf(GetObjectCommand);
  expect(signedCommand.input.ResponseCacheControl).toBe("public, max-age=600");
  expect(signedCommand.input.ResponseContentEncoding).toBe("gzip");
  expect(signedCommand.input.ResponseContentType).toBe("application/json");
});

test("S3Provider forwards client tuning options", async () => {
  const provider = new S3Provider({
    connectionTimeout: 2_000,
    maxAttempts: 5,
    maxSockets: 25,
    provider: "s3",
    region: "us-east-1",
    requestTimeout: 30_000,
    retryMode: "standard",
    socketTimeout: 15_000,
    throwOnRequestTimeout: true,
  });
  const client = (provider as unknown as { client: {
    config: {
      maxAttempts: () => Promise<number>;
      requestHandler: NodeHttpHandler & {
        configProvider: Promise<{
          connectionTimeout?: number;
          httpsAgent?: {
            keepAlive?: boolean;
            maxSockets?: number;
          };
          requestTimeout?: number;
          socketTimeout?: number;
          throwOnRequestTimeout?: boolean;
        }>;
      };
      retryMode?: string;
    };
  } }).client;
  const handlerConfig = await client.config.requestHandler.configProvider;

  await expect(client.config.maxAttempts()).resolves.toBe(5);
  expect(client.config.retryMode).toBe("standard");
  expect(handlerConfig.connectionTimeout).toBe(2_000);
  expect(handlerConfig.requestTimeout).toBe(30_000);
  expect(handlerConfig.socketTimeout).toBe(15_000);
  expect(handlerConfig.throwOnRequestTimeout).toBe(true);
  expect(handlerConfig.httpsAgent?.keepAlive).toBe(true);
  expect(handlerConfig.httpsAgent?.maxSockets).toBe(25);
});
