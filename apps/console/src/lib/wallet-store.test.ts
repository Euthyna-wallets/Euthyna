// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  demoWalletsEnabled,
  enforceWalletStoragePolicy,
  generatedEvmAccount,
  generatedNearWallet,
} from "./wallet-store.js";

beforeEach(() => {
  localStorage.clear();
});

describe("browser-generated wallet gate", () => {
  it("is disabled by default and never writes cleartext keys", () => {
    expect(demoWalletsEnabled()).toBe(false);
    expect(() => generatedNearWallet()).toThrow("disabled outside explicit UAT demo mode");
    expect(() => generatedEvmAccount()).toThrow("disabled outside explicit UAT demo mode");
    expect(localStorage.length).toBe(0);
  });

  it("purges legacy demo keys when normal mode starts", () => {
    localStorage.setItem("mandateos.dev.near.secretKey", "legacy-near-key");
    localStorage.setItem("mandateos.dev.evm.privateKey", "legacy-evm-key");
    enforceWalletStoragePolicy();
    expect(localStorage.length).toBe(0);
  });
});
