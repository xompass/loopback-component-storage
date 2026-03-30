import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { Transform, pipeline } from "node:stream";

import Busboy from "@fastify/busboy";
import createDebug from "debug";

import type {
  HttpError,
  PromiseCallback,
  ProviderDownloadRequest,
  ProviderUploadRequest,
  SignedUrlRequestOptions,
  StorageFile,
  StorageProvider,
  StorageRequest,
  StorageResponse,
  StorageUploadOptions,
  UploadFileContext,
  UploadStream,
} from "./types";
import {
  DEFAULT_MAX_FILE_SIZE,
  buildSignedLocalDownloadUrl,
  createError,
  createSignedUrlConfigError,
  validateSignedDownloadRequest,
  normalizeError,
  pickAwsUploadOptions,
  processDownloadError,
  resolveDownloadResponseOptions,
  resolveSignedUrlStrategy,
  shouldUseLocalSignedUrl,
  stripPath,
} from "./utils";

const debug = createDebug("loopback:storage:handler");

export function upload(
  provider: StorageProvider,
  req: StorageRequest,
  res: StorageResponse,
  options: StorageUploadOptions | PromiseCallback<UploadResult>,
  cb?: PromiseCallback<UploadResult>,
): void {
  let uploadOptions: StorageUploadOptions;
  let callback: PromiseCallback<UploadResult>;

  if (typeof options === "function") {
    uploadOptions = {};
    callback = options;
  } else {
    uploadOptions = options ?? {};
    callback = cb ?? (() => undefined);
  }

  const container = uploadOptions.container || req.params.container;
  const contentTypeHeader = req.headers["content-type"];

  if (!contentTypeHeader?.startsWith("multipart/form-data")) {
    callback(
      createError(
        "Expected a multipart/form-data request body",
        400,
        "INVALID_MULTIPART_REQUEST",
      ),
    );
    return;
  }

  const staticMaxFileSize =
    typeof uploadOptions.maxFileSize === "function"
      ? undefined
      : uploadOptions.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const limits: ConstructorParameters<typeof Busboy>[0]["limits"] = {};

  if (staticMaxFileSize !== undefined) {
    limits.fileSize = staticMaxFileSize;
  }

  if (uploadOptions.maxFieldsSize !== undefined) {
    limits.fieldSize = uploadOptions.maxFieldsSize;
  }

  const busboy = new Busboy({
    headers: {
      ...req.headers,
      "content-type": contentTypeHeader,
    },
    limits,
    preservePath: false,
  });

  debug("Uploading to container %s with options %o", container, uploadOptions);

  const files: Record<string, StorageFile[]> = {};
  const fields: Record<string, string[]> = {};
  const activeWriters = new Set<UploadStream>();
  let completed = false;
  let finishedParsing = false;
  let pendingFiles = 0;
  let receivedFile = false;
  let totalFieldBytes = 0;

  const finalize = (error?: HttpError | null, result?: UploadResult): void => {
    if (completed) {
      return;
    }

    completed = true;
    callback(error ?? null, result);
  };

  const abortRequest = (error: unknown): void => {
    const normalized = normalizeError(error);

    for (const writer of activeWriters) {
      void Promise.resolve(writer.abortUpload?.(normalized)).catch(
        () => undefined,
      );
    }

    req.unpipe(busboy);
    busboy.removeAllListeners();
    busboy.destroy();

    if (!req.destroyed) {
      req.destroy();
    }

    finalize(normalized);
  };

  const maybeComplete = (): void => {
    if (completed || !finishedParsing || pendingFiles !== 0) {
      return;
    }

    if (!receivedFile) {
      finalize(
        createError("No file content uploaded", 400, "NO_FILE_UPLOADED"),
      );
      return;
    }

    finalize(null, { fields, files });
  };

  busboy.on("field", (name, value, _nameTruncated, valueTruncated) => {
    if (completed) {
      return;
    }

    totalFieldBytes += Buffer.byteLength(value);

    if (
      uploadOptions.maxFieldsSize !== undefined &&
      totalFieldBytes > uploadOptions.maxFieldsSize
    ) {
      abortRequest(
        createError(
          `maxFieldsSize exceeded, received ${totalFieldBytes} bytes of field data`,
          413,
          "REQUEST_ENTITY_TOO_LARGE",
          {
            limit: uploadOptions.maxFieldsSize,
          },
        ),
      );
      return;
    }

    if (valueTruncated) {
      abortRequest(
        createError(
          `maxFieldsSize exceeded while reading field ${name}`,
          413,
          "REQUEST_ENTITY_TOO_LARGE",
          {
            limit: uploadOptions.maxFieldsSize,
          },
        ),
      );
      return;
    }

    const values = fields[name] ?? [];
    values.push(value);
    fields[name] = values;
  });

  busboy.on(
    "file",
    (fieldName, stream, filename, _transferEncoding, mimeType) => {
      if (!filename) {
        stream.resume();
        return;
      }

      receivedFile = true;

      const initialName = stripPath(filename);
      const file: UploadFileContext = {
        container,
        field: fieldName,
        name: initialName,
        request: req,
        response: res,
        type: mimeType || undefined,
      };

      const extension = extname(initialName);

      if (typeof uploadOptions.getFilename === "function") {
        file.originalFilename = file.name;
        file.name = uploadOptions.getFilename(file, req, res);
      } else if (uploadOptions.nameConflict === "makeUnique") {
        file.originalFilename = file.name;
        file.name = `${randomUUID()}${extension}`;
      }

      const allowedContentTypes = resolveAllowedContentTypes(
        uploadOptions,
        file,
        req,
        res,
      );

      if (
        allowedContentTypes.length > 0 &&
        file.type &&
        !allowedContentTypes.includes(file.type)
      ) {
        stream.resume();
        abortRequest(
          createError(
            `contentType "${file.type}" is not allowed (Must be in [${allowedContentTypes.join(", ")}])`,
            400,
            "CONTENT_TYPE_NOT_ALLOWED",
          ),
        );
        return;
      }

      const maxFileSize = resolveMaxFileSize(uploadOptions, file, req, res);

      if (uploadOptions.acl) {
        file.acl =
          typeof uploadOptions.acl === "function"
            ? uploadOptions.acl(file, req, res)
            : uploadOptions.acl;
      }

      const uploadRequest: ProviderUploadRequest = {
        ...pickAwsUploadOptions(uploadOptions),
        acl: file.acl,
        container,
        contentType: file.type,
        remote: file.name,
      };

      const writer = provider.upload(uploadRequest);
      activeWriters.add(writer);
      pendingFiles += 1;

      let settled = false;
      const settleFile = (): boolean => {
        if (settled) {
          return false;
        }

        settled = true;
        pendingFiles -= 1;
        activeWriters.delete(writer);
        return true;
      };

      const failFile = (error: unknown): void => {
        if (!settleFile()) {
          return;
        }

        const normalized = normalizeError(error);

        void Promise.resolve(writer.abortUpload?.(normalized))
          .catch(() => undefined)
          .finally(() => abortRequest(normalized));
      };

	      stream.once("limit", () => {
	        file.size = stream.bytesRead;
	        failFile(
	          createError(
	            `maxFileSize exceeded, received more than ${maxFileSize} bytes`,
	            413,
	            "REQUEST_ENTITY_TOO_LARGE",
	            {
	              limit: maxFileSize,
	            },
	          ),
	        );
	      });

      writer.once("error", failFile);
	      writer.once("success", (providerResponse) => {
	        if (!settleFile()) {
	          return;
	        }

	        file.size = stream.bytesRead;
	        file.providerResponse = providerResponse;
	        const values = files[fieldName] ?? [];
	        values.push(createStoredFileResult(file));
	        files[fieldName] = values;
	        maybeComplete();
	      });

	      if (staticMaxFileSize === undefined) {
	        pipeline(
	          stream,
	          createFileLimitTransform(file, maxFileSize),
	          writer,
	          (error) => {
	            if (error) {
	              failFile(error);
	            }
	          },
	        );
	        return;
	      }

	      pipeline(stream, writer, (error) => {
	        if (error) {
	          failFile(error);
	        }
	      });
	    },
	  );

  busboy.once("finish", () => {
    finishedParsing = true;
    maybeComplete();
  });

  busboy.once("error", (error) => {
    abortRequest(error);
  });

  req.pipe(busboy);
}

export function download(
  provider: StorageProvider,
  req: StorageRequest,
  res: StorageResponse,
  container: string | undefined,
  file: string | undefined,
  cb: PromiseCallback<void>,
  options?: SignedUrlRequestOptions,
): void {
  downloadInternal(provider, req, res, container, file, cb, true, options);
}

export function downloadSigned(
  provider: StorageProvider,
  req: StorageRequest,
  res: StorageResponse,
  container: string | undefined,
  file: string | undefined,
  cb: PromiseCallback<void>,
  options?: SignedUrlRequestOptions,
): void {
  downloadInternal(provider, req, res, container, file, cb, false, options);
}

function downloadInternal(
  provider: StorageProvider,
  req: StorageRequest,
  res: StorageResponse,
  container: string | undefined,
  file: string | undefined,
  cb: PromiseCallback<void>,
  allowSignedRedirect: boolean,
  options?: SignedUrlRequestOptions,
): void {
  const fileName = resolveRequestedFile(file, req);

  if (!fileName) {
    cb(createError("Missing file parameter", 400, "MISSING_FILE"));
    return;
  }

  const params: ProviderDownloadRequest = {
    container: container || req.params.container,
    remote: fileName,
  };
  const signedUrlConfig = provider.config?.signedUrl;
  const responseOptions = resolveDownloadResponseOptions(req, options);
  params.responseCacheControl = responseOptions.responseCacheControl;
  params.responseContentEncoding = responseOptions.responseContentEncoding;
  params.responseContentType = responseOptions.responseContentType;
  const signedUrlValidationError = validateSignedDownloadRequest(
    req,
    params.container,
    params.remote,
    signedUrlConfig?.secret,
    responseOptions,
  );

  if (signedUrlValidationError) {
    cb(signedUrlValidationError);
    return;
  }

  const signedUrlRequested = req.query?.signedUrl || req.query?.["signed-url"];
  const signedUrlStrategy = resolveSignedUrlStrategy(req, signedUrlConfig, options?.strategy);
  const useLocalSignedUrl = shouldUseLocalSignedUrl(signedUrlStrategy);

  if (
    allowSignedRedirect &&
    signedUrlRequested &&
    signedUrlConfig?.enabled
  ) {
    const expiresIn = signedUrlConfig.expiresIn;
    void resolveSignedUrl(
      provider,
      req,
      params,
      expiresIn,
      useLocalSignedUrl,
      signedUrlStrategy,
      responseOptions,
    ).then(
      (url) => {
        if (!url) {
          cb(null);
          return;
        }

        if (expiresIn) {
          const cacheTtl = Math.floor(expiresIn * 0.9);
          res.set("Cache-Control", `public, max-age=${cacheTtl}`);
        }

        res.redirect(url);
        cb(null);
      },
      (error) => cb(processDownloadError(error, params.remote)),
    );
    return;
  }

  const rangeHeader = req.headers.range;

  if (!rangeHeader) {
    pipeDownload(provider, res, params, fileName, cb);
    return;
  }

  void provider
    .getFile(params.container, params.remote)
    .then((metadata) => {
      setupPartialDownload(params, metadata.size, rangeHeader, res);
      pipeDownload(provider, res, params, fileName, cb);
    })
    .catch((error) => cb(processDownloadError(error, params.remote)));
}

export function getSignedUrl(
  provider: StorageProvider,
  req: StorageRequest,
  _res: StorageResponse,
  container: string | undefined,
  file: string | undefined,
  cb: PromiseCallback<{ url: string } | null>,
  options?: SignedUrlRequestOptions,
): void {
  const targetContainer = container || req.params.container;
  const targetFile = resolveRequestedFile(file, req);

  if (!targetFile) {
    cb(createError("Missing file parameter", 400, "MISSING_FILE"));
    return;
  }

  const signedUrlStrategy = resolveSignedUrlStrategy(
    req,
    provider.config?.signedUrl,
    options?.strategy,
  );
  const responseOptions = resolveDownloadResponseOptions(req, options);

  if (!provider.getSignedUrl) {
    if (!shouldUseLocalSignedUrl(signedUrlStrategy)) {
      cb(null, null);
      return;
    }
  }

  void resolveSignedUrl(
    provider,
    req,
    {
      container: targetContainer,
      remote: targetFile,
    },
    provider.config?.signedUrl?.expiresIn,
    shouldUseLocalSignedUrl(signedUrlStrategy),
    signedUrlStrategy,
    responseOptions,
  ).then(
    (url) => cb(null, url ? { url } : null),
    (error) => cb(processDownloadError(error, targetFile)),
  );
}

type UploadResult = {
  fields: Record<string, string[]>;
  files: Record<string, StorageFile[]>;
};

function createStoredFileResult(file: UploadFileContext): StorageFile {
  return {
    acl: file.acl,
    container: file.container,
    etag: file.etag,
    field: file.field,
    lastModified: file.lastModified,
    name: file.name,
    originalFilename: file.originalFilename,
    providerResponse: file.providerResponse,
    size: file.size,
    type: file.type,
    versionId: file.versionId,
  };
}

function resolveAllowedContentTypes(
  options: StorageUploadOptions,
  file: UploadFileContext,
  req: StorageRequest,
  res: StorageResponse,
): readonly string[] {
  if (!options.allowedContentTypes) {
    return [];
  }

  const value =
    typeof options.allowedContentTypes === "function"
      ? options.allowedContentTypes(file, req, res)
      : options.allowedContentTypes;

  return Array.isArray(value) ? value : [];
}

function resolveMaxFileSize(
  options: StorageUploadOptions,
  file: UploadFileContext,
  req: StorageRequest,
  res: StorageResponse,
): number {
  if (typeof options.maxFileSize === "function") {
    return options.maxFileSize(file, req, res) ?? DEFAULT_MAX_FILE_SIZE;
  }

  return options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
}

function createFileLimitTransform(file: StorageFile, maxFileSize: number): Transform {
  let bytesSeen = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
      bytesSeen += chunk.length;
      file.size = bytesSeen;

      if (bytesSeen > maxFileSize) {
        callback(
          createError(
            `maxFileSize exceeded, received ${bytesSeen} bytes of file data (max is ${maxFileSize})`,
            413,
            "REQUEST_ENTITY_TOO_LARGE",
            {
              limit: maxFileSize,
            },
          ),
        );
        return;
      }

      callback(null, chunk);
    },
  });
}

function pipeDownload(
  provider: StorageProvider,
  res: StorageResponse,
  params: ProviderDownloadRequest,
  fileName: string,
  cb: PromiseCallback<void>,
): void {
  const reader = provider.download(params);
  let settled = false;

  if (params.responseCacheControl) {
    res.set("Cache-Control", params.responseCacheControl);
  }
  if (params.responseContentEncoding) {
    res.set("Content-Encoding", params.responseContentEncoding);
  }
  if (params.responseContentType) {
    res.type(params.responseContentType);
  } else {
    res.type(stripPath(fileName));
  }
  reader.pipe(res);

  reader.once("error", (error) => {
    if (settled) {
      return;
    }

    settled = true;
    cb(processDownloadError(error, params.remote));
  });

  reader.once("end", () => {
    if (settled) {
      return;
    }

    settled = true;
    cb(null);
  });
}

function resolveRequestedFile(
  file: string | undefined,
  req: StorageRequest,
): string | undefined {
  if (file) {
    return file;
  }

  if (typeof req.params.file === "string" && req.params.file) {
    return req.params.file;
  }

  if (typeof req.params["0"] === "string" && req.params["0"]) {
    return req.params["0"];
  }

  const queryFile = req.query?.file;
  return typeof queryFile === "string" && queryFile ? queryFile : undefined;
}

function resolveSignedUrl(
  provider: StorageProvider,
  req: StorageRequest,
  params: ProviderDownloadRequest,
  expiresIn: number | undefined,
  useLocalSignedUrl: boolean,
  signedUrlStrategy: SignedUrlRequestOptions["strategy"],
  responseOptions: SignedUrlRequestOptions,
): Promise<string | null> {
  if (useLocalSignedUrl) {
    const secret = provider.config?.signedUrl?.secret;
    const validateBeforeSign =
      provider.config?.signedUrl?.validateBeforeSign ?? true;

    if (!secret) {
      return Promise.reject(createSignedUrlConfigError());
    }

    return Promise.resolve()
      .then(async () => {
        if (validateBeforeSign) {
          await provider.getFile(params.container, params.remote);
        }
      })
      .then(() =>
        buildSignedLocalDownloadUrl(
          req,
          params.container,
          params.remote,
          secret,
          expiresIn,
          provider.config?.signedUrl?.baseUrl,
          responseOptions,
        ),
      );
  }

  if (!provider.getSignedUrl) {
    return Promise.resolve(null);
  }

  return Promise.resolve(
    provider.getSignedUrl({
      ...params,
      expiresIn,
      request: req,
      responseCacheControl: responseOptions.responseCacheControl,
      responseContentEncoding: responseOptions.responseContentEncoding,
      responseContentType: responseOptions.responseContentType,
      strategy: signedUrlStrategy,
    }),
  );
}

function setupPartialDownload(
  params: ProviderDownloadRequest,
  totalSize: number | undefined,
  rangeHeader: string,
  res: StorageResponse,
): void {
  if (!totalSize) {
    return;
  }

  const [startPart, endPart] = rangeHeader.replace(/bytes=/, "").split("-");
  params.start = Number.parseInt(startPart, 10);
  params.end = endPart ? Number.parseInt(endPart, 10) : totalSize - 1;

  const chunkSize = params.end - params.start + 1;

  res.status(206);
  res.set("Content-Range", `bytes ${params.start}-${params.end}/${totalSize}`);
  res.set("Accept-Ranges", "bytes");
  res.set("Content-Length", chunkSize);
}
