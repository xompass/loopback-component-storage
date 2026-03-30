import type { IncomingHttpHeaders } from "node:http";
import type { Readable, Writable } from "node:stream";

import type {
  ObjectCannedACL,
  PutObjectCommandInput,
  ServerSideEncryption,
  StorageClass,
} from "@aws-sdk/client-s3";

export type MaybePromise<T> = T | Promise<T>;

export interface HttpError extends Error {
  code?: string;
  limit?: number;
  status?: number;
  statusCode?: number;
}

export type PromiseCallback<T> = ((
  error: HttpError | null,
  result?: T,
) => void) & {
  promise?: Promise<T>;
};

export interface StorageContainer {
  createdAt?: Date;
  etag?: string;
  lastModified?: Date;
  name: string;
  size?: number;
  [key: string]: unknown;
}

export interface StorageFile {
  acl?: string;
  container: string;
  etag?: string;
  field?: string;
  lastModified?: Date;
  name: string;
  originalFilename?: string;
  providerResponse?: unknown;
  size?: number;
  type?: string;
  versionId?: string;
  [key: string]: unknown;
}

export interface StorageRequest extends Readable {
  destroy(error?: Error): this;
  headers: IncomingHttpHeaders;
  method?: string;
  params: Record<string, string>;
  query?: Record<string, unknown>;
  resume(): this;
  unpipe(destination?: NodeJS.WritableStream): this;
  url?: string;
}

export interface StorageResponse extends Writable {
  redirect(url: string): this | void;
  set(field: string, value: number | string): this | void;
  status(code: number): this;
  type(value: string): this | void;
}

export type SignedUrlStrategy = "local" | "provider";

export interface SignedUrlOptions {
  baseUrl?: string;
  enabled?: boolean;
  expiresIn?: number;
  secret?: string;
  strategy?: SignedUrlStrategy;
  validateBeforeSign?: boolean;
}

export interface SignedUrlRequestOptions {
  strategy?: SignedUrlStrategy;
}

export interface UploadFileContext extends StorageFile {
  request: StorageRequest;
  response: StorageResponse;
}

export type FilenameResolver = (
  file: UploadFileContext,
  request: StorageRequest,
  response: StorageResponse,
) => string;

export type AllowedContentTypesResolver = (
  file: UploadFileContext,
  request: StorageRequest,
  response: StorageResponse,
) => readonly string[] | undefined;

export type MaxFileSizeResolver = (
  file: UploadFileContext,
  request: StorageRequest,
  response: StorageResponse,
) => number | undefined;

export type AclResolver = (
  file: UploadFileContext,
  request: StorageRequest,
  response: StorageResponse,
) => ObjectCannedACL | string | undefined;

export interface AwsUploadOptions {
  CacheControl?: PutObjectCommandInput["CacheControl"];
  SSECustomerAlgorithm?: PutObjectCommandInput["SSECustomerAlgorithm"];
  SSECustomerKey?: PutObjectCommandInput["SSECustomerKey"];
  SSECustomerKeyMD5?: PutObjectCommandInput["SSECustomerKeyMD5"];
  SSEKMSKeyId?: PutObjectCommandInput["SSEKMSKeyId"];
  ServerSideEncryption?: ServerSideEncryption | string;
  StorageClass?: StorageClass | string;
}

export interface StorageUploadOptions extends AwsUploadOptions {
  acl?: AclResolver | ObjectCannedACL | string;
  allowedContentTypes?: AllowedContentTypesResolver | readonly string[];
  container?: string;
  getFilename?: FilenameResolver;
  maxFieldsSize?: number;
  maxFileSize?: MaxFileSizeResolver | number;
  nameConflict?: "makeUnique" | "overwrite";
}

export interface ProviderUploadRequest extends AwsUploadOptions {
  acl?: ObjectCannedACL | string;
  container: string;
  contentType?: string;
  remote: string;
}

export interface ProviderDownloadRequest {
  container: string;
  end?: number;
  remote: string;
  start?: number;
}

export interface SignedUrlRequest {
  container: string;
  expiresIn?: number;
  remote: string;
  request?: StorageRequest;
  strategy?: SignedUrlStrategy;
  validateBeforeSign?: boolean;
}

export interface UploadStream extends Writable {
  abortUpload?: (error?: Error) => MaybePromise<void>;
}

export interface StorageProvider {
  readonly config?: {
    signedUrl?: SignedUrlOptions;
  };
  createContainer(options: { name: string }): Promise<StorageContainer>;
  destroyContainer(container: string): Promise<void>;
  download(options: ProviderDownloadRequest): Readable;
  getContainer(container: string): Promise<StorageContainer>;
  getContainers(): Promise<StorageContainer[]>;
  getFile(container: string, file: string): Promise<StorageFile>;
  getFiles(
    container: string,
    options?: Record<string, unknown>,
  ): Promise<StorageFile[]>;
  getSignedUrl?(options: SignedUrlRequest): MaybePromise<string | null>;
  removeFile(container: string, file: string): Promise<void>;
  upload(options: ProviderUploadRequest): UploadStream;
}

export interface FilesystemProviderOptions extends StorageUploadOptions {
  provider?: "filesystem";
  root: string;
  signedUrl?: SignedUrlOptions;
}

export interface S3ProviderOptions extends StorageUploadOptions {
  accessKeyId?: string;
  connectionTimeout?: number;
  endpoint?: string;
  forcePathStyle?: boolean;
  key?: string;
  keyId?: string;
  maxAttempts?: number;
  maxSockets?: number;
  provider: "amazon" | "aws" | "s3";
  region?: string;
  retryMode?: "adaptive" | "legacy" | "standard";
  requestTimeout?: number;
  secretAccessKey?: string;
  sessionToken?: string;
  signedUrl?: SignedUrlOptions;
  socketTimeout?: number;
  throwOnRequestTimeout?: boolean;
  uploadPartSize?: number;
  uploadQueueSize?: number;
  useAccelerateEndpoint?: boolean;
}

export type StorageComponentOptions =
  | FilesystemProviderOptions
  | S3ProviderOptions;

export interface DataSourceLike {
  connector?: StorageServiceConnector;
  settings?: StorageComponentOptions;
}

export interface StorageServiceConnector {
  DataAccessObject?: Record<string, unknown>;
  dataSource?: DataSourceLike;
  define?: (
    model: string,
    properties?: Record<string, unknown>,
    settings?: Record<string, unknown>,
  ) => void;
}

export type RemoteMethod<T extends (...args: any[]) => any> = T & {
  accepts?: unknown[];
  http?: Record<string, unknown>;
  returns?: Record<string, unknown>;
  shared?: boolean;
};
