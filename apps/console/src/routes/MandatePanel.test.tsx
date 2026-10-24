// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MandatePreview, MandateProposal, TreasuryView } from "../api.js";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  findDaoProposalsRpc: vi.fn(),
  nearAccounts: vi.fn(),
}));

vi.mock("../api.js", async (importActual) => ({
  ...await importActual<typeof import("../api.js")>(),
  api: mocks.api,
}));

vi.mock("../wallets.js", async (importActual) => ({
  ...await importActual<typeof import("../wallets.js")>(),
  findDaoProposalsRpc: mocks.findDaoProposalsRpc,
  nearAccounts: mocks.nearAccounts,
}));

import { MandatePanel } from "./OnboardingPage.js";

const proposal = (description: string): MandateProposal => ({
  receiverId: "dao.testnet",
  methodName: "add_proposal",
  description,
  args: { proposal: { description, kind: "Vote" } },
  deposit: "100000000000000000000000",
});

const setRole = proposal("Set mandate researcher [mandate:abc:set-role]");
const registerAgent = proposal("Register agent [mandate:abc:register-agent]");
const funding = proposal("Fund researcher budget [mandate:abc:funding]");
const relayDerive = proposal("Derive relay 0xGOV [mandate:abc:derive-relay]");
const zodiac = proposal("Configure Zodiac [mandate:abc:zodiac-0]");
const preview: MandatePreview = {
  roleKey: `0x${"11".repeat(32)}`,
  allowanceKey: `0x${"22".repeat(32)}`,
  vault: { config: {}, current: null },
  zodiac: { target: "0x1111111111111111111111111111111111111111", selector: "0x12345678", conditions: [], calls: [] },
  guard: {},
  diff: [],
  agentStatus: "ready",
  proposals: { vaultSetRole: setRole, vaultRegisterAgent: registerAgent, funding, relayDerive, zodiacRelay: zodiac },
  warnings: [],
};
const treasury = {
  daoAccountId: "dao.testnet",
  environment: "uat",
} as TreasuryView;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MandatePanel ordered DAO execution", () => {
  it("keeps later steps disabled until the previous proposal is Executed on-chain", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/v1/console/agents") return { agents: [] };
      if (path === "/v1/console/treasury/budget-token") {
        return {
          environment: "uat",
          tokenAccountId: "test-ft.testnet",
          symbol: "TestUSDC",
          decimals: 6,
          daoAccountId: "dao.testnet",
          vaultAccountId: "vault.testnet",
          daoStorageRegistered: true,
          vaultStorageRegistered: true,
          daoBalance: "6000000",
          storageDepositYocto: "1250000000000000000000",
        };
      }
      throw new Error(`unexpected API path ${path}`);
    });
    mocks.findDaoProposalsRpc.mockImplementation(async (_dao: string, descriptions: string[]) => ({
      [descriptions[0]!]: {
        id: 7,
        description: descriptions[0]!,
        state: "In progress",
        rawStatus: "InProgress",
        kind: "Vote",
      },
    }));
    mocks.nearAccounts.mockResolvedValue(["alice.testnet"]);

    render(<MandatePanel treasury={treasury} preview={preview} onPreview={() => undefined} onError={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/In progress · #7/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Use connected NEAR account" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Vote approve" }) as HTMLButtonElement).disabled).toBe(false));

    const proposeButtons = screen.getAllByRole("button", { name: "Propose" }) as HTMLButtonElement[];
    expect(proposeButtons).toHaveLength(4);
    expect(proposeButtons.every((button) => button.disabled)).toBe(true);
    expect(screen.getAllByText("Waiting for the previous proposal to be Executed on-chain.")).toHaveLength(4);
  });
  it("offers Re-propose for a failed step without unlocking the next one", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/v1/console/agents") return { agents: [] };
      if (path === "/v1/console/treasury/budget-token") {
        return {
          environment: "uat",
          tokenAccountId: "test-ft.testnet",
          symbol: "TestUSDC",
          decimals: 6,
          daoAccountId: "dao.testnet",
          vaultAccountId: "vault.testnet",
          daoStorageRegistered: true,
          vaultStorageRegistered: true,
          daoBalance: "6000000",
          storageDepositYocto: "1250000000000000000000",
        };
      }
      throw new Error(`unexpected API path ${path}`);
    });
    mocks.findDaoProposalsRpc.mockImplementation(async (_dao: string, descriptions: string[]) => ({
      [descriptions[0]!]: {
        id: 8,
        description: descriptions[0]!,
        state: "Failed",
        rawStatus: "Rejected",
        kind: "Vote",
      },
    }));
    mocks.nearAccounts.mockResolvedValue(["alice.testnet"]);

    render(<MandatePanel treasury={treasury} preview={preview} onPreview={() => undefined} onError={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/Failed · #8 · Rejected/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Use connected NEAR account" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Re-propose" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getAllByRole("button", { name: "Propose" })[0] as HTMLButtonElement).disabled).toBe(true);
  });

});
