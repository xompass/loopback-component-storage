import { defineConfig } from "tsdown/config";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["./src/index.ts"],
  format: "cjs",
  outDir: "dist",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
