import { getPublicKeyAsync, verifyAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { bytesToHex, concatHex, encodeFunctionData, hexToBytes, keccak256, stringToHex } from "viem";
import { serializeRelayStatusReport, serializeStatusReport, serializeVisa } from "./canonical.js";
import { digestVaultTransaction, hexToByteArray } from "./evm.js";
import { Guard } from "./guard.js";
import { EnvKmsSigner } from "./kms.js";
import type { GovernanceOperation, Registry, VaultOperation } from "./types.js";

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

  it("Guard refuses an uncovered recipient and emits no visa", async () => {
    const guard = testGuard();
    const result = await guard.approve(operationFor("0x2222222222222222222222222222222222222222"), registry);
    expect(result).toEqual({ decision: "escalate", reasons: ["recipient not registered"] });
    expect("approval" in result).toBe(false);
  });

  it("escalates when the persisted digest no longer matches the transaction", async () => {
    const guard = testGuard();
    const operation = operationFor();
    operation.tx_digest[0] = (operation.tx_digest[0] ?? 0) ^ 1;
    const result = await guard.approve(operation, registry);
    expect(result).toEqual({
      decision: "escalate",
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
  it("signs relay confirmations under the relay-only domain", async () => {
    const privateKey = statusPrivateKey;
    const guard = testGuard();
    const operation: GovernanceOperation = {
      op_id: Array(32).fill(4) as number[],
      proposer: "dao.testnet",
      target: Array(20).fill(5) as number[],
      value: "0",
      data: [1, 2, 3],
      operation: 1,
      evm_nonce: 0,
      transaction: operationFor().transaction,
      tx_digest: Array(32).fill(6) as number[],
      possibly_signed_at_block: 10,
      state: "PossiblySigned",
      signature: null,
      signed_transaction: [0x02, 0x01, 0x02],
      cancellation: null,
    };
    if (!operation.signed_transaction) throw new Error("signed transaction missing");
    const txHash = keccak256(bytesToHex(Uint8Array.from(operation.signed_transaction)));
    const signed = await guard.relayStatusReport("acme", operation, txHash, 42n, "Vetoed");
    if (!signed.report) throw new Error("relay report missing");
    const message = concatHex([
      stringToHex("mandateos:relay-status:v1"),
      bytesToHex(serializeRelayStatusReport(signed.report)),
    ]);
    expect(
      await verifyAsync(
        Buffer.from(signed.signature, "base64"),
        hexToBytes(message),
        await getPublicKeyAsync(privateKey),
      ),
    ).toBe(true);
    expect(signed.report.final_status).toBe("Vetoed");
  });

});
