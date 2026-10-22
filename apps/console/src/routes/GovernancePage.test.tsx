// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  buildDelayVetoBatch: vi.fn(),
  signSafeBatch: vi.fn(),
  executeSafeBatch: vi.fn(),
}));

vi.mock("../api.js", async (importActual) => ({
  ...await importActual<typeof import("../api.js")>(),
  api: mocks.api,
}));
vi.mock("../safe.js", async (importActual) => ({
  ...await importActual<typeof import("../safe.js")>(),
  buildDelayVetoBatch: mocks.buildDelayVetoBatch,
  signSafeBatch: mocks.signSafeBatch,
  executeSafeBatch: mocks.executeSafeBatch,
}));

import { GovernancePage } from "./GovernancePage.js";

const batch = {
  safe: "0x1111111111111111111111111111111111111111",
  multiSend: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
  nonce: 0n,
  to: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
  value: 0n,
  data: "0x1234",
  operation: 1,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: "0x0000000000000000000000000000000000000000",
  refundReceiver: "0x0000000000000000000000000000000000000000",
  safeTxHash: `0x${"11".repeat(32)}`,
} as const;

const governance = {
  proposals: [],
  daoAccountId: "dao.testnet",
  treasury: {
    organizationId: "org-1",
    environment: "uat",
    nearNetwork: "testnet",
    baseChainId: 84532,
    daoAccountId: "dao.testnet",
    vaultAccountId: "vault.testnet",
    relayAccountId: "relay.testnet",
    safeAddress: batch.safe,
    rolesAddress: "0x2222222222222222222222222222222222222222",
    delayAddress: "0x3333333333333333333333333333333333333333",
    govAddress: "0x4444444444444444444444444444444444444444",
    status: "active",
  },
  delay: {
    address: "0x3333333333333333333333333333333333333333",
    txNonce: "0",
    queueNonce: "1",
    cooldownSeconds: "300",
    expirationSeconds: "604800",
    safeThreshold: "2",
    currentTimestamp: "120",
  },
  operations: [{
    opId: `0x${"aa".repeat(32)}`,
    proposalId: 7,
    state: "Queued",
    txHash: `0x${"bb".repeat(32)}`,
    queueNonce: "0",
    executeTxHash: null,
    countdownSeconds: "280",
    cooldownEndsAt: "400",
    expiresAt: "604900",
    lastError: null,
  }],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GovernancePage", () => {
  it("renders the on-chain timeline and requires the Safe threshold for veto", async () => {
    mocks.api.mockResolvedValue(governance);
    mocks.buildDelayVetoBatch.mockResolvedValue(batch);
    mocks.signSafeBatch
      .mockResolvedValueOnce({ owner: "0x5555555555555555555555555555555555555555", signature: `0x${"01".repeat(65)}` })
      .mockResolvedValueOnce({ owner: "0x6666666666666666666666666666666666666666", signature: `0x${"02".repeat(65)}` });
    mocks.executeSafeBatch.mockResolvedValue(`0x${"cc".repeat(32)}`);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><GovernancePage /></QueryClientProvider>);

    await waitFor(() => expect(screen.getByText("280s remaining")).toBeTruthy());
    expect(screen.getByText("cooldown", { exact: false })).toBeTruthy();
    const execute = screen.getByRole("button", { name: "Execute veto" }) as HTMLButtonElement;
    expect(execute.disabled).toBe(true);

    const sign = screen.getByRole("button", { name: "Veto — sign with council wallet" });
    fireEvent.click(sign);
    await waitFor(() => expect(screen.getByText("1/2 Safe signatures")).toBeTruthy());
    expect(execute.disabled).toBe(true);
    fireEvent.click(sign);
    await waitFor(() => expect(screen.getByText("2/2 Safe signatures")).toBeTruthy());
    expect(execute.disabled).toBe(false);

    fireEvent.click(execute);
    await waitFor(() => expect(mocks.executeSafeBatch).toHaveBeenCalledOnce());
    expect(mocks.buildDelayVetoBatch).toHaveBeenCalledWith(governance.treasury, 1n);
  });
});
