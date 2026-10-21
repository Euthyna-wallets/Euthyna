import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@near-wallet-selector/modal-ui/styles.css";
import { App } from "./App.js";
import "./styles.css";

async function boot() {
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
