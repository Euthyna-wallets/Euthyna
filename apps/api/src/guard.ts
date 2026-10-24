import { bytesToHex, keccak256, type Hex } from "viem";
import { serializeRelayStatusReport, serializeStatusReport, serializeVisa, signDomainPayload, randomSafeNonce } from "./canonical.js";
import type { KmsSigner } from "./kms.js";
import { bytes32ToHex, digestVaultTransaction, hexToByteArray } from "./evm.js";
import { evaluateExactRules, type RegistryDecision } from "./registry.js";
import type { GovernanceOperation, GuardVisa, Registry, RelayFinalStatus, RelayStatusReport, SignedPayload, StatusReport, VaultOperation } from "./types.js";

export interface GuardApproval {
  decision: "approve";
  vendorId: string;
  vendorName: string;
  approval: { visa: GuardVisa; signature: string };
}

export type GuardResult = GuardApproval | Extract<RegistryDecision, { decision: "escalate" }>;

export class Guard {
  constructor(private readonly signer: KmsSigner) {}

  async approve(operation: VaultOperation, registry: Registry): Promise<GuardResult> {
    if (operation.state !== "Prepared") {
      return { decision: "escalate", reasons: [`operation state is ${operation.state}, expected Prepared`] };
    }
    const recomputed = digestVaultTransaction(operation);
    if (recomputed !== bytes32ToHex(operation.tx_digest)) {
      return { decision: "escalate", reasons: ["Vault tx_digest does not match canonical EIP-1559 transaction"] };
    }
    const decision = evaluateExactRules(registry, operation);
    if (decision.decision === "escalate") return decision;
    const visa: GuardVisa = {
      client_id: operation.client_id,
      op_id: operation.op_id,
      tx_digest: operation.tx_digest,
      agent: operation.member,
      role: operation.role,
      reference: operation.request.reference,
      policy_version: operation.policy_version,
      registry_version: operation.registry_version,
      visa_nonce: randomSafeNonce(),
      expires_at_ns: operation.expires_at_ns,
    };
    const signature = await signDomainPayload("mandateos:visa:v1", serializeVisa(visa), this.signer);
    return {
      decision: "approve",
      vendorId: decision.vendorId,
      vendorName: decision.vendorName,
      approval: { visa, signature },
    };
  }

  confirmationReport(
    operation: VaultOperation,
    txHash: Hex,
    blockNumber: bigint,
  ): Promise<SignedPayload<StatusReport>> {
    return this.statusReport(operation, txHash, blockNumber, "Confirmed");
  }

  failureReport(
    operation: VaultOperation,
    txHash: Hex,
    blockNumber: bigint,
  ): Promise<SignedPayload<StatusReport>> {
    return this.statusReport(operation, txHash, blockNumber, "Failed");
  }

  private async statusReport(
    operation: VaultOperation,
    txHash: Hex,
    blockNumber: bigint,
    kind: StatusReport["kind"],
  ): Promise<SignedPayload<StatusReport>> {
    if (!operation.signed_transaction) throw new Error("operation has no signed transaction");
    const storedHash = keccak256(bytesToHex(Uint8Array.from(operation.signed_transaction)));
    if (storedHash !== txHash) throw new Error("receipt hash does not match the stored signed transaction");
    if (blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Base block number exceeds safe integer range");
    const report: StatusReport = {
      client_id: operation.client_id,
      op_id: operation.op_id,
      kind,
      tx_hash: hexToByteArray(txHash),
      report_nonce: randomSafeNonce(),
      block_number: Number(blockNumber),
    };
    const signature = await signDomainPayload(
      "mandateos:status:v1",
      serializeStatusReport(report),
      this.signer,
    );
    return { report, signature };
  }
  async relayStatusReport(
    clientId: string,
    operation: GovernanceOperation,
    txHash: Hex,
    blockNumber: bigint,
    finalStatus: RelayFinalStatus,
  ): Promise<SignedPayload<RelayStatusReport>> {
    if (!operation.signed_transaction) throw new Error("relay operation has no signed transaction");
    const storedHash = keccak256(bytesToHex(Uint8Array.from(operation.signed_transaction)));
    if (storedHash !== txHash) throw new Error("receipt hash does not match the relay signed transaction");
    if (blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Base block number exceeds safe integer range");
    const report: RelayStatusReport = {
      client_id: clientId,
      op_id: operation.op_id,
      final_status: finalStatus,
      tx_hash: hexToByteArray(txHash),
      report_nonce: randomSafeNonce(),
      block_number: Number(blockNumber),
    };
    const signature = await signDomainPayload(
      "mandateos:relay-status:v1",
      serializeRelayStatusReport(report),
      this.signer,
    );
    return { report, signature };
  }

}
