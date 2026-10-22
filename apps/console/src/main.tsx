import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@near-wallet-selector/modal-ui/styles.css";
import { enforceWalletStoragePolicy } from "./lib/wallet-store.js";
import { App } from "./App.js";
import "./styles.css";

async function boot() {
  enforceWalletStoragePolicy();
  if (import.meta.env.VITE_E2E === "1") {
    const { installE2eSigners } = await import("./test/e2e-signers.js");
    await installE2eSigners();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
