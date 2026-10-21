import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm dev",
    port: 5173,
    reuseExistingServer: true,
    env: { ...process.env, VITE_E2E: "1", NODE_ENV: "test", AUTH_E2E_PASSWORD: "1" },
  },
});
