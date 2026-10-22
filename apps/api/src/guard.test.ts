import { getPublicKeyAsync, verifyAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { bytesToHex, concatHex, hexToBytes, keccak256, stringToHex } from "viem";
import { serializeVisa } from "./canonical.js";
import { digestVaultTransaction, hexToByteArray } from "./evm.js";
import { Guard } from "./guard.js";
import { EnvKmsSigner } from "./kms.js";
import type { Registry, VaultOperation } from "./types.js";

const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7c" as const;
const recipient = "0x1111111111111111111111111111111111111111" as const;
const registry: Registry = {
  clientId: "acme",
  registryVersion: 11,
  network: "base-sepolia",
  chainId: 84532,
  token: { symbol: "USDC", address: token, decimals: 6 },
  roles: {
    researcher: {
      maximumPayment: "5000000",
      vendors: [{ id: "lab", name: "Research Lab", addresses: [{ address: recipient }] }],
    },
  },
};

function addressBytes(address: `0x${string}`): number[] {
  return Array.from(Buffer.from(address.slice(2), "hex"));
}

function operationFor(target: `0x${string}` = recipient): VaultOperation {
  const operation: VaultOperation = {
    op_id: Array(32).fill(1) as number[],
    client_id: "acme",
    agent: "researcher.agent.testnet",
    role: "researcher",
    intent: {
      token: addressBytes(token),
      recipient: addressBytes(target),
      amount: "1000000",
      reference: "INV-001",
      gas_limit: "200000",
      max_fee_per_gas: "20000000000",
      max_priority_fee_per_gas: "1000000000",
    },
    policy_version: 7,
    registry_version: 11,
    evm_nonce: 0,
    transaction: {
      chain_id: 84532,
      nonce: 0,
      to: Array(20).fill(0x44) as number[],
      value: "0",
      input: [0xc6, 0xfe, 0x87, 0x47],
      gas_limit: "200000",
      max_fee_per_gas: "20000000000",
      max_priority_fee_per_gas: "1000000000",
    },
    tx_digest: Array(32).fill(0) as number[],
    expires_at_block: 1_000,
    possibly_signed_at_block: null,
    state: "Prepared",
    signature: null,
    signed_transaction: null,
    cancellation: null,
  };
  operation.tx_digest = hexToByteArray(digestVaultTransaction(operation));
  return operation;
}

describe("Guard exact rules", () => {
  it("signs the exact prepared transaction and produces a verifiable domain-separated visa", async () => {
    const privateKey = Uint8Array.from({ length: 32 }, () => 7);
    const guard = new Guard(new EnvKmsSigner(privateKey));
    const result = await guard.approve(operationFor(), registry);
    expect(result.decision).toBe("approve");
    if (result.decision !== "approve") throw new Error("expected approval");
    const message = concatHex([
      stringToHex("mandateos:visa:v1"),
      bytesToHex(serializeVisa(result.approval.visa)),
    ]);
    expect(
      await verifyAsync(
        Buffer.from(result.approval.signature, "base64"),
        hexToBytes(message),
        await getPublicKeyAsync(privateKey),
      ),
    ).toBe(true);
  });

  it("Guard refuses an uncovered recipient and emits no visa", async () => {
    const guard = new Guard(new EnvKmsSigner(Uint8Array.from({ length: 32 }, () => 7)));
    const result = await guard.approve(operationFor("0x2222222222222222222222222222222222222222"), registry);
    expect(result).toEqual({ decision: "escalate", reasons: ["recipient not registered"] });
    expect("approval" in result).toBe(false);
  });

  it("escalates when the persisted digest no longer matches the transaction", async () => {
    const guard = new Guard(new EnvKmsSigner(Uint8Array.from({ length: 32 }, () => 7)));
    const operation = operationFor();
    operation.tx_digest[0] = (operation.tx_digest[0] ?? 0) ^ 1;
    const result = await guard.approve(operation, registry);
    expect(result).toEqual({
      decision: "escalate",
      reasons: ["Vault tx_digest does not match canonical EIP-1559 transaction"],
    });
  });

  it("refuses to confirm a hash other than the stored raw transaction hash", async () => {
    const guard = new Guard(new EnvKmsSigner(Uint8Array.from({ length: 32 }, () => 7)));
    const operation = operationFor();
    operation.state = "PossiblySigned";
    operation.signed_transaction = [0x02, 0x01, 0x02];
    await expect(
      guard.confirmationReport(operation, keccak256("0x0304"), 1n),
    ).rejects.toThrow("receipt hash does not match the stored signed transaction");
  });
});
