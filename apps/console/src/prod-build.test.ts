import { build } from "vite";
import { readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const appRoot = resolve(import.meta.dirname, "..");

describe("production bundle isolation", () => {
  it("does not contain the test signer module", async () => {
    const output = resolve(appRoot, "dist-check");
    await rm(output, { recursive: true, force: true });
    await build({
      root: appRoot,
      configFile: resolve(appRoot, "vite.config.ts"),
      logLevel: "error",
      build: { outDir: "dist-check", emptyOutDir: true },
    });
    const assets = (await readdir(resolve(output, "assets"))).filter((file) => file.endsWith(".js"));
    const bundle = (
      await Promise.all(assets.map((file) => readFile(resolve(output, "assets", file), "utf8")))
    ).join("\n");
    expect(bundle).not.toContain("MANDATEOS_E2E_SIGNERS_V1");
    expect(bundle).not.toContain("__MANDATEOS_E2E_NEAR__");
    await rm(output, { recursive: true, force: true });
  }, 60_000);
});
