// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  demoWalletsEnabled,
  enforceWalletStoragePolicy,
  generatedEvmAccount,
  generatedNearWallet,
  setDemoWalletScope,
  selectDemoWalletScopeForAccounts,
  selectDemoWalletScopeForEvmAddress,
} from "./wallet-store.js";

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_UAT_DEMO_MODE", "0");
  vi.stubEnv("VITE_E2E", "0");
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    localStorage.setItem("mandateos.dev.near.secretKey.user-one", "scoped-near-key");
    enforceWalletStoragePolicy();
    expect(localStorage.length).toBe(0);
  });

  it("migrates legacy demo keys into a passkey-profile scope", () => {
    localStorage.setItem("mandateos.dev.near.secretKey", "legacy-near-key");
    localStorage.setItem("mandateos.dev.evm.privateKey", "legacy-evm-key");
    setDemoWalletScope("user-one");
    expect(localStorage.getItem("mandateos.dev.near.secretKey.user-one")).toBe("legacy-near-key");
    expect(localStorage.getItem("mandateos.dev.evm.privateKey.user-one")).toBe("legacy-evm-key");
    expect(localStorage.getItem("mandateos.dev.near.secretKey")).toBeNull();
    setDemoWalletScope("user-two");
    expect(localStorage.getItem("mandateos.dev.near.secretKey.user-two")).toBeNull();

    localStorage.setItem("mandateos.dev.near.secretKey.anonymous", "signup-near-key");
    setDemoWalletScope("user-two");
    expect(localStorage.getItem("mandateos.dev.near.secretKey.user-two")).toBe("signup-near-key");
    expect(localStorage.getItem("mandateos.dev.near.secretKey.anonymous")).toBeNull();
  });

  it("selects the scoped demo keypair matching declared public accounts", () => {
    const evmKey = `0x${"01".repeat(32)}`;
    localStorage.setItem("mandateos.dev.near.secretKey.member-two", "near-secret");
    localStorage.setItem("mandateos.dev.near.accountId.member-two", "member-two.testnet");
    localStorage.setItem("mandateos.dev.evm.privateKey.member-two", evmKey);
    expect(selectDemoWalletScopeForAccounts(
      "member-two.testnet",
      "0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1",
    )).toBe(true);
    expect(selectDemoWalletScopeForAccounts(
      "another.testnet",
      "0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1",
    )).toBe(false);
    expect(selectDemoWalletScopeForEvmAddress(
      "0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1",
    )).toBe(true);
  });
});
