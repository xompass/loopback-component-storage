import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  statSync,
} from "node:fs";
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  FilesystemProviderOptions,
  ProviderDownloadRequest,
  ProviderUploadRequest,
  SignedUrlRequest,
  StorageContainer,
  StorageFile,
  StorageProvider,
  UploadStream,
} from "../types";
import {
  DEFAULT_SIGNED_URL_EXPIRES_IN,
  buildSignedLocalDownloadUrl,
  createSignedUrlConfigError,
  splitRelativeStoragePath,
  validateSimpleName,
  validateRelativeStoragePath,
} from "../utils";

const DESTROY_CONTAINER_CONCURRENCY = 8;

export class FilesystemProvider implements StorageProvider {
  readonly config?: {
    signedUrl?: FilesystemProviderOptions["signedUrl"];
  };

  private readonly root: string;

  constructor(options: FilesystemProviderOptions) {
    this.root = isAbsolute(options.root)
      ? options.root
      : resolve(process.cwd(), options.root);
    this.config = {
      signedUrl: options.signedUrl,
    };
  }

  async getContainers(): Promise<StorageContainer[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const containers: StorageContainer[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const containerPath = join(this.root, entry.name);
      const metadata = await stat(containerPath);
      containers.push({
        createdAt: metadata.birthtime,
        lastModified: metadata.mtime,
        name: entry.name,
      });
    }

    return containers;
  }

  async createContainer(options: { name: string }): Promise<StorageContainer> {
    validateSimpleName(options.name);
    const containerPath = this.resolveContainerPath(options.name);
    await mkdir(containerPath);
    const metadata = await stat(containerPath);

    return {
      createdAt: metadata.birthtime,
      lastModified: metadata.mtime,
      name: options.name,
    };
  }

  async destroyContainer(container: string): Promise<void> {
    validateSimpleName(container);
    const containerPath = this.resolveContainerPath(container);
    const entries = await readdir(containerPath, { withFileTypes: true });
    let nextEntryIndex = 0;
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(DESTROY_CONTAINER_CONCURRENCY, entries.length);

    for (let index = 0; index < workerCount; index += 1) {
      workers.push(
        (async () => {
          while (true) {
            const entryIndex = nextEntryIndex;
            nextEntryIndex += 1;
            const entry = entries[entryIndex];

            if (!entry) {
              return;
            }

            await rm(join(containerPath, entry.name), {
              force: false,
              recursive: true,
            });
          }
        })(),
      );
    }

    await Promise.all(workers);

    await rm(containerPath, { force: false, recursive: false });
  }

  async getContainer(container: string): Promise<StorageContainer> {
    validateSimpleName(container);
    const metadata = await stat(this.resolveContainerPath(container));

    return {
      createdAt: metadata.birthtime,
      lastModified: metadata.mtime,
      name: container,
    };
  }

  upload(options: ProviderUploadRequest): UploadStream {
    validateSimpleName(options.container);
    validateRelativeStoragePath(options.remote);

    const containerPath = this.resolveContainerPath(options.container);
    const filePath = this.resolveFilePath(options.container, options.remote);
    statSync(containerPath);
    mkdirSync(dirname(filePath), { recursive: true });
    const writer = createWriteStream(filePath, {
      flags: "w",
      mode: 0o666,
    }) as UploadStream;

    let completed = false;

    writer.once("finish", async () => {
      if (completed) {
        return;
      }

      completed = true;

      try {
        const metadata = await stat(filePath);
        const storedFile: StorageFile = {
          container: options.container,
          lastModified: metadata.mtime,
          name: options.remote,
          size: metadata.size,
          type: options.contentType,
        };
        writer.emit("success", storedFile);
      } catch (error) {
        writer.emit("error", error);
      }
    });

    writer.abortUpload = async (error?: Error) => {
      completed = true;
      writer.destroy(error);
      await rm(filePath, { force: true });
    };

    return writer;
  }

  download(options: ProviderDownloadRequest) {
    validateSimpleName(options.container);
    validateRelativeStoragePath(options.remote);

    return createReadStream(
      this.resolveFilePath(options.container, options.remote),
      {
        end: options.end,
        start: options.start,
      },
    );
  }

  async getFiles(
    container: string,
    _options?: Record<string, unknown>,
  ): Promise<StorageFile[]> {
    validateSimpleName(container);
    const containerPath = this.resolveContainerPath(container);
    const files = await this.walkFiles(container, containerPath);
    return files;
  }

  async getFile(container: string, file: string): Promise<StorageFile> {
    validateSimpleName(container);
    validateRelativeStoragePath(file);
    const metadata = await stat(this.resolveFilePath(container, file));

    return {
      container,
      lastModified: metadata.mtime,
      name: file,
      size: metadata.size,
    };
  }

  async removeFile(container: string, file: string): Promise<void> {
    validateSimpleName(container);
    validateRelativeStoragePath(file);
    await unlink(this.resolveFilePath(container, file));
  }

  async getSignedUrl(options: SignedUrlRequest): Promise<string | null> {
    validateSimpleName(options.container);
    validateRelativeStoragePath(options.remote);

    const secret = this.config?.signedUrl?.secret;

    if (!secret) {
      throw createSignedUrlConfigError();
    }

    const validateBeforeSign =
      options.validateBeforeSign ??
      this.config?.signedUrl?.validateBeforeSign ??
      true;

    if (validateBeforeSign) {
      await this.getFile(options.container, options.remote);
    }

    if (!options.request) {
      throw createSignedUrlConfigError();
    }

    return buildSignedLocalDownloadUrl(
      options.request,
      options.container,
      options.remote,
      secret,
      options.expiresIn ?? this.config?.signedUrl?.expiresIn ?? DEFAULT_SIGNED_URL_EXPIRES_IN,
      this.config?.signedUrl?.baseUrl,
      options,
    );
  }

  private async walkFiles(
    container: string,
    currentPath: string,
  ): Promise<StorageFile[]> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    const files: StorageFile[] = [];

    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await this.walkFiles(container, entryPath)));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const metadata = await stat(entryPath);
      files.push({
        container,
        lastModified: metadata.mtime,
        name: this.toRelativeRemotePath(container, entryPath),
        size: metadata.size,
      });
    }

    return files;
  }

  private resolveContainerPath(container: string): string {
    return join(this.root, container);
  }

  private resolveFilePath(container: string, file: string): string {
    return join(
      this.resolveContainerPath(container),
      ...splitRelativeStoragePath(file),
    );
  }

  private toRelativeRemotePath(container: string, filePath: string): string {
    const relativePath = relative(this.resolveContainerPath(container), filePath);
    const normalizedPath = relativePath.split("\\").join("/");
    validateRelativeStoragePath(normalizedPath);
    return normalizedPath;
  }
}
