import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { basename } from "node:path";

import type {
  AwsUploadOptions,
  HttpError,
  PromiseCallback,
  SignedUrlOptions,
  SignedUrlStrategy,
  StorageUploadOptions,
  StorageRequest,
} from "./types";

export const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
export const DEFAULT_SIGNED_URL_EXPIRES_IN = 15 * 60;

const SIMPLE_NAME_PATTERN = /^[^/\\]+$/;
const DOWNLOAD_PATH_SEGMENT = "/download/";
const SIGNED_DOWNLOAD_PATH_SEGMENT = "/signed-download/";
const MISSING_DOWNLOAD_ERROR_CODES = new Set([
  "ENOENT",
  "NoSuchBucket",
  "NoSuchKey",
  "NotFound",
]);
const STRIPPED_SIGNED_URL_QUERY_PARAMS = new Set([
  "apikey",
  "api_key",
  "auth",
  "awsaccesskeyid",
  "bearer",
  "expires",
  "jwt",
  "session",
  "session_id",
  "sessionid",
  "sig",
  "signature",
  "signed-url",
  "signedurl",
  "x-amz-algorithm",
  "x-amz-credential",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-security-token",
  "x-amz-signature",
  "x-amz-signedheaders",
]);

export function createPromiseCallback<T>(): PromiseCallback<T> {
  let callback: PromiseCallback<T>;

  const promise = new Promise<T>((resolve, reject) => {
    callback = ((error: HttpError | null, result?: T) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result as T);
    }) as PromiseCallback<T>;
  });

  callback!.promise = promise;
  return callback!;
}

export function runWithCallback<T>(
  promise: Promise<T>,
  callback?: PromiseCallback<T>,
): Promise<T> | undefined {
  const handler = callback ?? createPromiseCallback<T>();

  promise.then(
    (result) => handler(null, result),
    (error) => handler(normalizeError(error)),
  );

  return handler.promise;
}

export function normalizeError(error: unknown): HttpError {
  if (error instanceof Error) {
    return error as HttpError;
  }

  const normalized = new Error(String(error)) as HttpError;
  return normalized;
}

export function createError(
  message: string,
  statusCode: number,
  code?: string,
  extras?: Partial<HttpError>,
): HttpError {
  const error = new Error(message) as HttpError;
  error.status = statusCode;
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  if (extras) {
    Object.assign(error, extras);
  }
  return error;
}

export function createInvalidNameError(name: string): HttpError {
  return createError(`Invalid name: ${name}`, 400, "INVALID_NAME");
}

export function validateSimpleName(name: string): void {
  if (!name || !SIMPLE_NAME_PATTERN.test(name) || name.includes("..")) {
    throw createInvalidNameError(name);
  }
}

export function validateRelativeStoragePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\")
  ) {
    throw createInvalidNameError(path);
  }

  const segments = path.split("/");

  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !SIMPLE_NAME_PATTERN.test(segment),
    )
  ) {
    throw createInvalidNameError(path);
  }
}

export function splitRelativeStoragePath(path: string): string[] {
  validateRelativeStoragePath(path);
  return path.split("/");
}

export function encodeStoragePath(path: string): string {
  return splitRelativeStoragePath(path).map(encodeURIComponent).join("/");
}

export function stripPath(filename: string): string {
  return basename(filename);
}

export async function waitForEvent(
  emitter: NodeJS.EventEmitter,
  eventName: string,
): Promise<unknown[]> {
  return once(emitter, eventName);
}

export function processDownloadError(
  error: unknown,
  fileName: string,
): HttpError {
  const normalized = normalizeError(error);
  const errorCode =
    normalized.code ??
    getStringProperty(normalized, "Code") ??
    normalized.name;
  const metadataStatusCode = getMetadataStatusCode(normalized);

  if (
    (errorCode && MISSING_DOWNLOAD_ERROR_CODES.has(errorCode)) ||
    metadataStatusCode === 404
  ) {
    normalized.message = `File not found: ${fileName}`;
    normalized.status = 404;
    normalized.statusCode = 404;
    if (!normalized.code && errorCode) {
      normalized.code = errorCode;
    }
    delete normalized.stack;
  }

  return normalized;
}

export function createSignedUrlConfigError(): HttpError {
  return createError(
    "Local signed URLs require signedUrl.secret to be configured",
    500,
    "SIGNED_URL_NOT_CONFIGURED",
  );
}

export function createSignedUrlExpiredError(): HttpError {
  return createError("Signed URL has expired", 403, "SIGNED_URL_EXPIRED");
}

export function createInvalidSignedUrlError(): HttpError {
  return createError("Invalid signed URL", 403, "INVALID_SIGNED_URL");
}

export function createSignedUrlSignature(
  secret: string,
  container: string,
  remote: string,
  expiresAt: number,
): string {
  return createHmac("sha256", secret)
    .update(container)
    .update("\n")
    .update(remote)
    .update("\n")
    .update(String(expiresAt))
    .digest("hex");
}

export function verifySignedUrlSignature(
  secret: string,
  container: string,
  remote: string,
  expiresAt: number,
  signature: string,
): boolean {
  const expected = Buffer.from(
    createSignedUrlSignature(secret, container, remote, expiresAt),
    "utf8",
  );
  const received = Buffer.from(signature, "utf8");

  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function validateSignedDownloadRequest(
  request: StorageRequest,
  container: string,
  remote: string,
  secret?: string,
): HttpError | null {
  if (!secret) {
    return null;
  }

  const signatureValue = request.query?.signature;
  const expiresValue = request.query?.expires;

  if (signatureValue === undefined && expiresValue === undefined) {
    return null;
  }

  if (typeof signatureValue !== "string" || typeof expiresValue !== "string") {
    return createInvalidSignedUrlError();
  }

  const expiresAt = Number(expiresValue);

  if (!Number.isInteger(expiresAt)) {
    return createInvalidSignedUrlError();
  }

  if (Math.floor(Date.now() / 1000) > expiresAt) {
    return createSignedUrlExpiredError();
  }

  if (
    !verifySignedUrlSignature(secret, container, remote, expiresAt, signatureValue)
  ) {
    return createInvalidSignedUrlError();
  }

  return null;
}

export function buildSignedLocalDownloadUrl(
  request: StorageRequest,
  container: string,
  remote: string,
  secret: string,
  expiresIn = DEFAULT_SIGNED_URL_EXPIRES_IN,
  baseUrl?: string,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  const signature = createSignedUrlSignature(secret, container, remote, expiresAt);
  const downloadUrl = createRequestScopedUrl(
    request,
    buildDownloadPath(container, remote),
    baseUrl,
  );
  downloadUrl.pathname = toSignedDownloadPath(downloadUrl.pathname);
  stripUnsafeSignedUrlQueryParams(downloadUrl.searchParams);
  downloadUrl.searchParams.set("file", remote);
  downloadUrl.searchParams.set("expires", String(expiresAt));
  downloadUrl.searchParams.set("signature", signature);

  if (downloadUrl.origin === LOCAL_REQUEST_URL_ORIGIN) {
    return `${downloadUrl.pathname}${downloadUrl.search}`;
  }

  return downloadUrl.toString();
}

export function shouldUseLocalSignedUrl(strategy?: SignedUrlStrategy): boolean {
  return strategy === "local";
}

export function normalizeSignedUrlStrategy(
  value: unknown,
): SignedUrlStrategy | undefined {
  return value === "local" || value === "provider" ? value : undefined;
}

export function resolveSignedUrlStrategy(
  request: StorageRequest | undefined,
  signedUrlOptions?: SignedUrlOptions,
  override?: SignedUrlStrategy,
): SignedUrlStrategy | undefined {
  if (override) {
    return override;
  }

  const requestOverride = normalizeSignedUrlStrategy(
    request?.query?.signedUrlStrategy ?? request?.query?.["signed-url-strategy"],
  );

  return requestOverride ?? signedUrlOptions?.strategy;
}

function getStringProperty(error: HttpError, property: string): string | undefined {
  const value = (error as unknown as Record<string, unknown>)[property];
  return typeof value === "string" ? value : undefined;
}

function getMetadataStatusCode(error: HttpError): number | undefined {
  const metadata = (error as unknown as Record<string, unknown>).$metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const httpStatusCode = (metadata as Record<string, unknown>).httpStatusCode;
  return typeof httpStatusCode === "number" ? httpStatusCode : undefined;
}

export function pickAwsUploadOptions(
  options: StorageUploadOptions,
): AwsUploadOptions {
  const picked: AwsUploadOptions = {};

  for (const key of AWS_UPLOAD_OPTION_NAMES) {
    if (options[key] !== undefined) {
      picked[key] = options[key];
    }
  }

  return picked;
}

export const AWS_UPLOAD_OPTION_NAMES = [
  "StorageClass",
  "CacheControl",
  "ServerSideEncryption",
  "SSEKMSKeyId",
  "SSECustomerAlgorithm",
  "SSECustomerKey",
  "SSECustomerKeyMD5",
] as const;

const LOCAL_REQUEST_URL_ORIGIN = "http://loopback-component-storage.local";

function createRequestScopedUrl(
  request: StorageRequest,
  fallbackPath: string,
  baseUrl?: string,
): URL {
  if (baseUrl) {
    return new URL(request.url ?? fallbackPath, ensureTrailingSlash(baseUrl));
  }

  const host = getForwardedOrDirectHeader(request, "x-forwarded-host", "host");

  if (!host) {
    return new URL(
      request.url ?? fallbackPath,
      `${LOCAL_REQUEST_URL_ORIGIN}/`,
    );
  }

  const protocol = getForwardedOrDirectHeader(request, "x-forwarded-proto") ?? "http";
  return new URL(
    request.url ?? fallbackPath,
    `${protocol}://${host}/`,
  );
}

function getForwardedOrDirectHeader(
  request: StorageRequest,
  ...headerNames: string[]
): string | undefined {
  for (const headerName of headerNames) {
    const headerValue = request.headers[headerName];

    if (typeof headerValue === "string" && headerValue) {
      return headerValue.split(",")[0]?.trim();
    }
  }

  return undefined;
}

function buildDownloadPath(container: string, remote: string): string {
  return `/${encodeURIComponent(container)}${DOWNLOAD_PATH_SEGMENT.slice(0, -1)}?file=${encodeURIComponent(remote)}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function toSignedDownloadPath(pathname: string): string {
  const pathSuffix = SIGNED_DOWNLOAD_PATH_SEGMENT.slice(0, -1);
  const downloadIndex = pathname.lastIndexOf(DOWNLOAD_PATH_SEGMENT);

  if (downloadIndex !== -1) {
    return `${pathname.slice(0, downloadIndex)}${pathSuffix}`;
  }

  if (pathname.endsWith(DOWNLOAD_PATH_SEGMENT.slice(0, -1))) {
    return `${pathname.slice(0, -DOWNLOAD_PATH_SEGMENT.slice(0, -1).length)}${pathSuffix}`;
  }

  const signedDownloadIndex = pathname.lastIndexOf(SIGNED_DOWNLOAD_PATH_SEGMENT);
  if (signedDownloadIndex !== -1) {
    return `${pathname.slice(0, signedDownloadIndex)}${pathSuffix}`;
  }

  if (pathname.endsWith(SIGNED_DOWNLOAD_PATH_SEGMENT.slice(0, -1))) {
    return pathname;
  }

  return `${trimTrailingSlash(pathname)}${pathSuffix}`;
}

function trimTrailingSlash(value: string): string {
  if (value === "/") {
    return value.slice(0, -1);
  }

  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function stripUnsafeSignedUrlQueryParams(searchParams: URLSearchParams): void {
  const parameterNames = new Set<string>();

  for (const parameterName of searchParams.keys()) {
    parameterNames.add(parameterName);
  }

  for (const parameterName of parameterNames) {
    if (shouldStripSignedUrlQueryParam(parameterName)) {
      searchParams.delete(parameterName);
    }
  }
}

function shouldStripSignedUrlQueryParam(parameterName: string): boolean {
  const normalizedName = parameterName.toLowerCase();

  return (
    normalizedName.includes("authorization") ||
    normalizedName.includes("password") ||
    normalizedName.includes("secret") ||
    normalizedName.includes("token") ||
    STRIPPED_SIGNED_URL_QUERY_PARAMS.has(normalizedName)
  );
}
