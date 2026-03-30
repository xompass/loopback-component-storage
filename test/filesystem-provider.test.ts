import { vi, afterEach, expect, test } from "vitest";

const { readdirMock, rmMock } = vi.hoisted(() => ({
  readdirMock: vi.fn(),
  rmMock: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );

  return {
    ...actual,
    readdir: readdirMock,
    rm: rmMock,
  };
});

import { FilesystemProvider } from "../src/providers/filesystem";

afterEach(() => {
  readdirMock.mockReset();
  rmMock.mockReset();
});

test("destroyContainer deletes entries with bounded concurrency", async () => {
  const provider = new FilesystemProvider({
    provider: "filesystem",
    root: "/tmp/lb-storage-filesystem-provider",
  });
  let activeDeletes = 0;
  let maxConcurrentDeletes = 0;

  readdirMock.mockResolvedValue(
    Array.from({ length: 20 }, (_, index) => ({
      name: `entry-${index}`,
    })),
  );
  rmMock.mockImplementation(async (targetPath: string) => {
    if (targetPath.endsWith("/docs")) {
      return;
    }

    activeDeletes += 1;
    maxConcurrentDeletes = Math.max(maxConcurrentDeletes, activeDeletes);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    activeDeletes -= 1;
  });

  await provider.destroyContainer("docs");

  expect(maxConcurrentDeletes).toBeLessThanOrEqual(8);
  expect(rmMock).toHaveBeenCalledTimes(21);
});
