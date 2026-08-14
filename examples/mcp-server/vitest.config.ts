import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The server logs refusals to stderr on purpose; silence it so a passing run
    // is readable.
    env: { LOG_LEVEL: "silent" },
  },
});
