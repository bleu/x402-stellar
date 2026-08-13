import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // The catalog tests share one Postgres, and each resets the schema it owns.
    // Run files one at a time so they cannot tear down each other's fixtures.
    fileParallelism: false,
  },
});
