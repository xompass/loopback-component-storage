import { FilesystemProvider } from "./providers/filesystem";
import { S3Provider } from "./providers/s3";
import type {
  FilesystemProviderOptions,
  S3ProviderOptions,
  StorageComponentOptions,
  StorageProvider,
} from "./types";
import { createError } from "./utils";

export function createClient(
  options: StorageComponentOptions,
): StorageProvider {
  const provider = normalizeProviderName(options.provider);

  switch (provider) {
    case "filesystem":
      return new FilesystemProvider(options as FilesystemProviderOptions);
    case "amazon":
    case "aws":
    case "s3":
      return new S3Provider({
        ...options,
        provider,
      } as S3ProviderOptions);
    default:
      throw createError(
        `Unsupported storage provider: ${String(options.provider)}`,
        400,
        "UNSUPPORTED_PROVIDER",
      );
  }
}

function normalizeProviderName(provider?: string): string {
  return (provider ?? "filesystem").toLowerCase();
}
