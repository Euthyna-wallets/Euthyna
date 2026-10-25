import { getPublicKeyAsync, verifyAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { bytesToHex, concatHex, encodeFunctionData, hexToBytes, keccak256, stringToHex } from "viem";
import { serializeStatusReport, serializeVisa } from "./canonical.js";
import { digestVaultTransaction, hexToByteArray } from "./evm.js";
import type { GuardContext } from "./registry.js";
import { Guard } from "./guard.js";
import { EnvKmsSigner } from "./kms.js";
import type { VaultOperation } from "./types.js";

const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7c" as const;
const recipient = "0x1111111111111111111111111111111111111111" as const;
const visaPrivateKey = Uint8Array.from({ length: 32 }, () => 7);
const statusPrivateKey = Uint8Array.from({ length: 32 }, () => 8);

function testGuard(): Guard {
  return new Guard(
    new EnvKmsSigner(visaPrivateKey),
    new EnvKmsSigner(statusPrivateKey),
  );
}

const erc20TransferAbi = [{
  type: "function",
  name: "transfer",
  stateMutability: "nonpayable",
  inputs: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}] as const;
const registry: GuardContext = {
  suppliers: [{ id: "lab", name: "Research Lab", address: recipient }],
  companyWallet: "0x3333333333333333333333333333333333333333",
};

function addressBytes(address: `0x${string}`): number[] {
  return Array.from(Buffer.from(address.slice(2), "hex"));
}

function operationFor(target: `0x${string}` = recipient): VaultOperation {
  const calldata = Array.from(hexToBytes(encodeFunctionData({
    abi: erc20TransferAbi,
    functionName: "transfer",
    args: [target, 1_000_000n],
  })));
  const operation: VaultOperation = {
    op_id: Array(32).fill(1) as number[],
    client_id: "acme",
    member: "researcher.agent.testnet",
    role: "researcher",
    request: {
      chain_id: 84532,
      target: addressBytes(token),
      value: "0",
      calldata,
      allowance_amount: "1000000",
      reference: "INV-001",
      gas_limit: "200000",
      max_fee_per_gas: "20000000000",
      max_priority_fee_per_gas: "1000000000",
    },
    permission_index: 0,
    consumptions: [{ key: Array(32).fill(0x55), amount: "1000000", calls_only: false }],
    measured_value: "1000000",
    policy_version: 7,
    registry_version: 11,
    evm_nonce: 0,
    transaction: {
      chain_id: 84532,
      nonce: 0,
      to: addressBytes(token),
      value: "0",
      input: calldata,
      gas_limit: "200000",
      max_fee_per_gas: "20000000000",
      max_priority_fee_per_gas: "1000000000",
    },
    tx_digest: Array(32).fill(0) as number[],
    created_at_ns: "1",
    expires_at_ns: "1000000000000",
    execute_after_ns: null,
    visa_authorized: false,
    cosigned_by: null,
    possibly_signed_at_ns: null,
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
    const privateKey = visaPrivateKey;
    const guard = testGuard();
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

  it("accepts a transfer back to the company wallet", async () => {
    const result = await testGuard().approve(operationFor("0x3333333333333333333333333333333333333333"), registry);
    expect(result.decision).toBe("approve");
  });

  it("Guard refuses an uncovered recipient and emits no visa", async () => {
    const guard = testGuard();
    const result = await guard.approve(operationFor("0x2222222222222222222222222222222222222222"), registry);
    expect(result.decision).toBe("refuse");
    expect(result.decision === "refuse" && result.reasons[0]).toContain("is not a registered supplier");
    expect("approval" in result).toBe(false);
  });

  it("refuses when the persisted digest no longer matches the transaction", async () => {
    const guard = testGuard();
    const operation = operationFor();
    operation.tx_digest[0] = (operation.tx_digest[0] ?? 0) ^ 1;
    const result = await guard.approve(operation, registry);
    expect(result).toEqual({
      decision: "refuse",
      reasons: ["Vault tx_digest does not match canonical EIP-1559 transaction"],
    });
  });

  it("refuses to confirm a hash other than the stored raw transaction hash", async () => {
    const guard = testGuard();
    const operation = operationFor();
    operation.state = "PossiblySigned";
    operation.signed_transaction = [0x02, 0x01, 0x02];
    await expect(
      guard.confirmationReport(operation, keccak256("0x0304"), 1n),
    ).rejects.toThrow("receipt hash does not match the stored signed transaction");
  });

});
