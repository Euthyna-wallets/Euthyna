import { configDefaults, defineConfig } from "vitest/config";

// Vitest 4 no longer skips dist/ by default: run the sources, not the compiled copies.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "**/dist/**"] } });
