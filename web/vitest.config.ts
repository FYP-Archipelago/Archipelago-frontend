import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    globals: true,
    environment: "node",
    // The golden fixtures are a few hundred KB each and the largest run builds
    // ~11k nodes; the default 5s is tight on a cold run.
    testTimeout: 30_000,
  },
});
