import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@near-wallet-selector/modal-ui/styles.css";
// The legacy stylesheet loads first so the Marbre et orichalque styles (imported by the routes) win over it.
import "./styles.css";
import { enforceWalletStoragePolicy } from "./lib/wallet-store.js";
import { App } from "./App.js";

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
