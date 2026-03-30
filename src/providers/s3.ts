import { PassThrough } from "node:stream";

import {
  type BucketLocationConstraint,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  type ObjectCannedACL,
  S3Client,
  type S3ClientConfig,
  type ServerSideEncryption,
  type StorageClass,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import type {
  ProviderDownloadRequest,
  ProviderUploadRequest,
  S3ProviderOptions,
  SignedUrlRequest,
  StorageContainer,
  StorageFile,
  StorageProvider,
  UploadStream,
} from "../types";

export class S3Provider implements StorageProvider {
  readonly config?: {
    signedUrl?: S3ProviderOptions["signedUrl"];
  };

  private readonly client: S3Client;
  private readonly region?: string;
  private readonly uploadPartSize?: number;
  private readonly uploadQueueSize?: number;

  constructor(options: S3ProviderOptions) {
    this.region = options.region;
    this.uploadPartSize = options.uploadPartSize;
    this.uploadQueueSize = options.uploadQueueSize;
    this.config = {
      signedUrl: options.signedUrl,
    };

    const clientOptions: S3ClientConfig = {
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      maxAttempts: options.maxAttempts,
      region: options.region,
      retryMode: options.retryMode,
      useAccelerateEndpoint: options.useAccelerateEndpoint,
    };

    const accessKeyId = options.accessKeyId ?? options.keyId;
    const secretAccessKey = options.secretAccessKey ?? options.key;

    if (accessKeyId && secretAccessKey) {
      clientOptions.credentials = {
        accessKeyId,
        secretAccessKey,
        sessionToken: options.sessionToken,
      };
    }

    const requestHandler = createRequestHandler(options);

    if (requestHandler) {
      clientOptions.requestHandler = requestHandler;
    }

    this.client = new S3Client(clientOptions);
  }

  async getContainers(): Promise<StorageContainer[]> {
    const result = await this.client.send(new ListBucketsCommand({}));

    return (result.Buckets ?? [])
      .filter((bucket) => bucket.Name)
      .map((bucket) => ({
        createdAt: bucket.CreationDate,
        name: bucket.Name as string,
      }));
  }

  async createContainer(options: { name: string }): Promise<StorageContainer> {
    await this.client.send(
      new CreateBucketCommand({
        Bucket: options.name,
        ...(this.region && this.region !== "us-east-1"
          ? {
              CreateBucketConfiguration: {
                LocationConstraint: this.region as BucketLocationConstraint,
              },
            }
          : {}),
      }),
    );

    return {
      name: options.name,
    };
  }

  async destroyContainer(container: string): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: container,
          ContinuationToken: continuationToken,
        }),
      );

      const objects = (page.Contents ?? [])
        .filter((item) => item.Key)
        .map((item) => ({
          Key: item.Key as string,
        }));

      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: container,
            Delete: {
              Objects: objects,
              Quiet: true,
            },
          }),
        );
      }

      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);

    await this.client.send(new DeleteBucketCommand({ Bucket: container }));
  }

  async getContainer(container: string): Promise<StorageContainer> {
    await this.client.send(new HeadBucketCommand({ Bucket: container }));
    return {
      name: container,
    };
  }

  upload(options: ProviderUploadRequest): UploadStream {
    const body = new PassThrough();
    const stream = body as UploadStream;

    const upload = new Upload({
      client: this.client,
      leavePartsOnError: false,
      params: {
        ACL: options.acl as ObjectCannedACL | undefined,
        Body: body,
        Bucket: options.container,
        CacheControl: options.CacheControl,
        ContentType: options.contentType,
        Key: options.remote,
        SSECustomerAlgorithm: options.SSECustomerAlgorithm,
        SSECustomerKey: options.SSECustomerKey,
        SSECustomerKeyMD5: options.SSECustomerKeyMD5,
        SSEKMSKeyId: options.SSEKMSKeyId,
        ServerSideEncryption: options.ServerSideEncryption as
          | ServerSideEncryption
          | undefined,
        StorageClass: options.StorageClass as StorageClass | undefined,
      },
      partSize: this.uploadPartSize,
      queueSize: this.uploadQueueSize,
    });

    stream.abortUpload = async (error?: Error) => {
      body.destroy(error);
      await upload.abort();
    };

    upload.done().then(
      (result) => {
        const storedFile: StorageFile = {
          container: options.container,
          etag: stripEtag(result.ETag),
          name: options.remote,
          versionId: result.VersionId,
        };
        stream.emit("success", storedFile);
      },
      (error) => stream.emit("error", error),
    );

    return stream;
  }

  download(options: ProviderDownloadRequest) {
    const output = new PassThrough();

    void this.client
      .send(
        new GetObjectCommand({
          Bucket: options.container,
          Key: options.remote,
          Range:
            options.start !== undefined
              ? `bytes=${options.start}-${options.end ?? ""}`
              : undefined,
        }),
      )
      .then((result) => {
        if (!result.Body || !("pipe" in result.Body)) {
          output.destroy(new Error("S3 did not return a readable body"));
          return;
        }

        result.Body.on("error", (error) => output.destroy(error));
        result.Body.pipe(output);
      })
      .catch((error) => output.destroy(error));

    return output;
  }

  async getFiles(
    container: string,
    _options?: Record<string, unknown>,
  ): Promise<StorageFile[]> {
    const files: StorageFile[] = [];
    let continuationToken: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: container,
          ContinuationToken: continuationToken,
        }),
      );

      for (const item of page.Contents ?? []) {
        if (!item.Key) {
          continue;
        }

        files.push({
          container,
          etag: stripEtag(item.ETag),
          lastModified: item.LastModified,
          name: item.Key,
          size: item.Size,
        });
      }

      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return files;
  }

  async getFile(container: string, file: string): Promise<StorageFile> {
    const result = await this.client.send(
      new HeadObjectCommand({
        Bucket: container,
        Key: file,
      }),
    );

    return {
      container,
      etag: stripEtag(result.ETag),
      lastModified: result.LastModified,
      name: file,
      size: result.ContentLength,
    };
  }

  async removeFile(container: string, file: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: container,
        Key: file,
      }),
    );
  }

  async getSignedUrl(options: SignedUrlRequest): Promise<string | null> {
    const expiresIn = options.expiresIn ?? this.config?.signedUrl?.expiresIn;
    const validateBeforeSign =
      options.validateBeforeSign ??
      this.config?.signedUrl?.validateBeforeSign ??
      true;

    if (validateBeforeSign) {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: options.container,
          Key: options.remote,
        }),
      );
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: options.container,
        Key: options.remote,
      }),
      expiresIn ? { expiresIn } : undefined,
    );
  }
}

function stripEtag(etag?: string): string | undefined {
  return etag?.replaceAll('"', "");
}

function createRequestHandler(
  options: S3ProviderOptions,
): NodeHttpHandler | undefined {
  if (
    options.connectionTimeout === undefined &&
    options.maxSockets === undefined &&
    options.requestTimeout === undefined &&
    options.socketTimeout === undefined &&
    options.throwOnRequestTimeout === undefined
  ) {
    return undefined;
  }

  return new NodeHttpHandler({
    connectionTimeout: options.connectionTimeout,
    httpsAgent:
      options.maxSockets === undefined
        ? undefined
        : {
            maxSockets: options.maxSockets,
          },
    requestTimeout: options.requestTimeout,
    socketTimeout: options.socketTimeout,
    throwOnRequestTimeout: options.throwOnRequestTimeout,
  });
}
