import createDebug from "debug";

import { createClient } from "./factory";
import * as handler from "./storage-handler";
import type {
  PromiseCallback,
  RemoteMethod,
  SignedUrlRequestOptions,
  StorageComponentOptions,
  StorageContainer,
  StorageFile,
  StorageProvider,
  StorageRequest,
  StorageResponse,
  StorageUploadOptions,
} from "./types";
import {
  createPromiseCallback,
  pickAwsUploadOptions,
  runWithCallback,
} from "./utils";

const debug = createDebug("loopback:storage:service");

export default class StorageService {
  static modelName = "storage";

  readonly client: StorageProvider;
  readonly provider: string;

  private readonly uploadDefaults: StorageUploadOptions;

  constructor(options: StorageComponentOptions) {
    this.provider = options.provider ?? "filesystem";
    this.client = createClient(options);
    this.uploadDefaults = {
      ...pickAwsUploadOptions(options),
      acl: options.acl,
      allowedContentTypes: options.allowedContentTypes,
      getFilename: options.getFilename,
      maxFieldsSize: options.maxFieldsSize,
      maxFileSize: options.maxFileSize,
      nameConflict: options.nameConflict,
    };
  }

  getContainers(cb?: PromiseCallback<StorageContainer[]>) {
    return runWithCallback(this.client.getContainers(), cb);
  }

  createContainer(
    options: { Name?: string; name?: string } = {},
    cb?: PromiseCallback<StorageContainer>,
  ) {
    const normalized = {
      name: options.name ?? options.Name ?? "",
    };
    debug("Creating container with options %o", normalized);
    return runWithCallback(this.client.createContainer(normalized), cb);
  }

  destroyContainer(container: string, cb?: PromiseCallback<void>) {
    return runWithCallback(this.client.destroyContainer(container), cb);
  }

  getContainer(container: string, cb?: PromiseCallback<StorageContainer>) {
    return runWithCallback(this.client.getContainer(container), cb);
  }

  uploadStream(
    container?: string,
    file?: string,
    options: Partial<StorageUploadOptions> = {},
  ) {
    return this.client.upload({
      ...pickAwsUploadOptions(options),
      container: container ?? options.container ?? "",
      contentType: undefined,
      remote: file ?? "",
    });
  }

  downloadStream(
    container?: string,
    file?: string,
    options: { end?: number; start?: number } = {},
  ) {
    return this.client.download({
      container: container ?? "",
      end: options.end,
      remote: file ?? "",
      start: options.start,
    });
  }

  getFiles(
    container: string,
    options?: Record<string, unknown> | PromiseCallback<StorageFile[]>,
    cb?: PromiseCallback<StorageFile[]>,
  ) {
    if (typeof options === "function") {
      return runWithCallback(this.client.getFiles(container), options);
    }

    return runWithCallback(this.client.getFiles(container, options), cb);
  }

  getFile(container: string, file: string, cb?: PromiseCallback<StorageFile>) {
    return runWithCallback(this.client.getFile(container, file), cb);
  }

  removeFile(container: string, file: string, cb?: PromiseCallback<void>) {
    return runWithCallback(this.client.removeFile(container, file), cb);
  }

  upload(
    container: string | StorageRequest,
    req?: StorageRequest,
    res?: StorageResponse | StorageUploadOptions,
    options?: StorageUploadOptions | PromiseCallback<UploadResponse>,
    cb?: PromiseCallback<UploadResponse>,
  ) {
    let resolvedContainer = container;
    let resolvedRequest = req;
    let resolvedResponse = res as StorageResponse | undefined;
    let resolvedOptions = options;
    let resolvedCallback = cb;

    if (typeof container === "object" && "headers" in container) {
      resolvedContainer = "";
      resolvedRequest = container;
      resolvedResponse = req as unknown as StorageResponse;
      resolvedOptions = res as
        | StorageUploadOptions
        | PromiseCallback<UploadResponse>;
      resolvedCallback = options as PromiseCallback<UploadResponse>;
    }

    if (typeof resolvedOptions === "function") {
      resolvedCallback = resolvedOptions;
      resolvedOptions = {};
    }

    const callback =
      resolvedCallback ?? createPromiseCallback<UploadResponse>();
    const mergedOptions: StorageUploadOptions = {
      ...this.uploadDefaults,
      ...resolvedOptions,
    };

    if (typeof resolvedContainer === "string" && resolvedContainer) {
      mergedOptions.container = resolvedContainer;
    }

    debug("Upload configured with options %o", mergedOptions);
    handler.upload(
      this.client,
      resolvedRequest as StorageRequest,
      resolvedResponse as StorageResponse,
      mergedOptions,
      callback,
    );

    return callback.promise;
  }

  download(
    container: string,
    file: string,
    req: StorageRequest,
    res: StorageResponse,
    options?: PromiseCallback<void> | SignedUrlRequestOptions,
    cb?: PromiseCallback<void>,
  ) {
    const signedUrlOptions =
      typeof options === "function" ? undefined : options;
    const callback =
      (typeof options === "function" ? options : cb) ?? createPromiseCallback<void>();
    handler.download(
      this.client,
      req,
      res,
      container,
      file,
      callback,
      signedUrlOptions,
    );
    return callback.promise;
  }

  downloadSigned(
    container: string,
    file: string,
    req: StorageRequest,
    res: StorageResponse,
    options?: PromiseCallback<void> | SignedUrlRequestOptions,
    cb?: PromiseCallback<void>,
  ) {
    const signedUrlOptions =
      typeof options === "function" ? undefined : options;
    const callback =
      (typeof options === "function" ? options : cb) ?? createPromiseCallback<void>();
    handler.downloadSigned(
      this.client,
      req,
      res,
      container,
      file,
      callback,
      signedUrlOptions,
    );
    return callback.promise;
  }

  getSignedUrl(
    container: string,
    file: string,
    req: StorageRequest,
    res: StorageResponse,
    options?:
      | PromiseCallback<{ url: string } | null>
      | SignedUrlRequestOptions,
    cb?: PromiseCallback<{ url: string } | null>,
  ) {
    const signedUrlOptions =
      typeof options === "function" ? undefined : options;
    const callback =
      (typeof options === "function" ? options : cb) ??
      createPromiseCallback<{ url: string } | null>();
    handler.getSignedUrl(
      this.client,
      req,
      res,
      container,
      file,
      callback,
      signedUrlOptions,
    );
    return callback.promise;
  }
}

type UploadResponse = {
  fields: Record<string, string[]>;
  files: Record<string, StorageFile[]>;
};

attachRemoteMetadata();

function attachRemoteMetadata() {
  const prototype = StorageService.prototype as Record<
    string,
    RemoteMethod<any>
  >;

  prototype.getContainers.shared = true;
  prototype.getContainers.accepts = [];
  prototype.getContainers.returns = {
    arg: "containers",
    root: true,
    type: "array",
  };
  prototype.getContainers.http = { path: "/", verb: "get" };

  prototype.getContainer.shared = true;
  prototype.getContainer.accepts = [
    {
      arg: "container",
      http: { source: "path" },
      required: true,
      type: "string",
    },
  ];
  prototype.getContainer.returns = {
    arg: "container",
    root: true,
    type: "object",
  };
  prototype.getContainer.http = { path: "/:container", verb: "get" };

  prototype.createContainer.shared = true;
  prototype.createContainer.accepts = [
    { arg: "options", http: { source: "body" }, type: "object" },
  ];
  prototype.createContainer.returns = {
    arg: "container",
    root: true,
    type: "object",
  };
  prototype.createContainer.http = { path: "/", verb: "post" };

  prototype.destroyContainer.shared = true;
  prototype.destroyContainer.accepts = [
    {
      arg: "container",
      http: { source: "path" },
      required: true,
      type: "string",
    },
  ];
  prototype.destroyContainer.returns = {};
  prototype.destroyContainer.http = { path: "/:container", verb: "delete" };

  prototype.getFiles.shared = true;
  prototype.getFiles.accepts = [
    {
      arg: "container",
      http: { source: "path" },
      required: true,
      type: "string",
    },
  ];
  prototype.getFiles.returns = { arg: "files", root: true, type: "array" };
  prototype.getFiles.http = { path: "/:container/files", verb: "get" };

  prototype.getFile.shared = true;
  prototype.getFile.accepts = [
    {
      arg: "container",
      http: { source: "path" },
      required: true,
      type: "string",
    },
    { arg: "file", http: { source: "path" }, required: true, type: "string" },
  ];
  prototype.getFile.returns = { arg: "file", root: true, type: "object" };
  prototype.getFile.http = { path: "/:container/files/:file(*)", verb: "get" };

  prototype.removeFile.shared = true;
  prototype.removeFile.accepts = [
    {
      arg: "container",
      http: { source: "path" },
      required: true,
      type: "string",
    },
    { arg: "file", http: { source: "path" }, required: true, type: "string" },
  ];
  prototype.removeFile.returns = {};
  prototype.removeFile.http = {
    path: "/:container/files/:file(*)",
    verb: "delete",
  };

  prototype.upload.shared = true;
  prototype.upload.accepts = [
    {
      arg: "container",
      http: { source: "path" },
      required: true,
      type: "string",
    },
    { arg: "req", http: { source: "req" }, type: "object" },
    { arg: "res", http: { source: "res" }, type: "object" },
  ];
  prototype.upload.returns = { arg: "result", type: "object" };
  prototype.upload.http = { path: "/:container/upload", verb: "post" };

  prototype.download.shared = true;
  prototype.download.accepts = [
    {
      arg: "container",
      http: { source: "path" },
      required: true,
      type: "string",
    },
    { arg: "file", http: { source: "query" }, type: "string" },
    { arg: "req", http: { source: "req" }, type: "object" },
    { arg: "res", http: { source: "res" }, type: "object" },
  ];
  prototype.download.returns = {};
  prototype.download.http = [
    {
      path: "/:container/download",
      verb: "get",
    },
    {
      path: "/:container/download/:file(*)",
      verb: "get",
    },
  ];

  prototype.downloadSigned.shared = true;
  prototype.downloadSigned.accepts = [
    {
      arg: "container",
      http: { source: "path" },
      required: true,
      type: "string",
    },
    { arg: "file", http: { source: "query" }, type: "string" },
    { arg: "req", http: { source: "req" }, type: "object" },
    { arg: "res", http: { source: "res" }, type: "object" },
  ];
  prototype.downloadSigned.returns = {};
  prototype.downloadSigned.http = [
    {
      path: "/:container/signed-download",
      verb: "get",
    },
    {
      path: "/:container/signed-download/:file(*)",
      verb: "get",
    },
  ];
}
