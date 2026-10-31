import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } })],
  // Noir and Barretenberg load their own WebAssembly: let them, unbundled (seat recovery's ZK Email prover).
  optimizeDeps: { exclude: ["@noir-lang/noirc_abi", "@noir-lang/acvm_js", "@noir-lang/noir_js", "@aztec/bb.js"] },
  server: {
    port: 5173,
    proxy: {
      "/near-rpc": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        timeout: 600_000,
        proxyTimeout: 600_000,
        rewrite: () => "/v1/console/near-rpc",
      },
    },
  },
});
