import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage"
    },
    globals: true,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"]
  }
});
