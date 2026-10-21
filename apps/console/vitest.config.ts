import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["e2e/**", "dist/**", "dist-check/**"],
    testTimeout: 60_000,
  },
});
