import StorageService from "./storage-service";
import type { DataSourceLike, StorageServiceConnector } from "./types";

export function initialize(
  dataSource: DataSourceLike,
  callback?: (error?: Error | null) => void,
): void {
  const settings = dataSource.settings ?? {
    provider: "filesystem",
    root: ".",
  };

  const connector = new StorageService(settings) as StorageService &
    StorageServiceConnector;

  dataSource.connector = connector;
  connector.dataSource = dataSource;
  connector.DataAccessObject = function DataAccessObject() {
    return undefined;
  } as unknown as Record<string, unknown>;

  const dataAccessObject = connector.DataAccessObject as Record<
    string,
    unknown
  >;

  for (const key of Object.getOwnPropertyNames(StorageService.prototype)) {
    if (key === "constructor") {
      continue;
    }

    const method = (connector as unknown as Record<string, unknown>)[key];
    if (typeof method !== "function") {
      continue;
    }

    const boundMethod = method.bind(connector);
    Object.assign(boundMethod, method);
    dataAccessObject[key] = boundMethod;
  }

  connector.define = () => undefined;
  callback?.(null);
}
