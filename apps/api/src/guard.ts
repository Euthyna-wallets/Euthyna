import { bytesToHex, keccak256, type Hex } from "viem";
import { serializeStatusReport, serializeVisa, signDomainPayload, randomSafeNonce } from "./canonical.js";
import type { KmsSigner } from "./kms.js";
import { bytes32ToHex, digestSponsoredBatch, digestSponsoredExecute, digestVaultTransaction, hexToByteArray, type SponsoredApproval } from "./evm.js";
import { evaluateOperation, type GuardContext } from "./registry.js";
import type { GuardVisa, SignedPayload, StatusReport, VaultOperation } from "./types.js";

export interface GuardApproval {
  decision: "approve";
  vendorId: string | null;
  vendorName: string | null;
  approval: { visa: GuardVisa; signature: string };
}

export type GuardResult = GuardApproval | { decision: "refuse"; reasons: string[] };

export class Guard {
  constructor(
    private readonly visaSigner: KmsSigner,
    private readonly statusSigner: KmsSigner,
  ) {}

  /** `sponsored`: the vault signs this operation as the wallet's EIP-712 Execute (EIP-7702), not a transaction. */
  async approve(operation: VaultOperation, context: GuardContext, sponsored?: { wallet: `0x${string}`; deadline: bigint; approval?: SponsoredApproval | null } | null): Promise<GuardResult> {
    if (operation.state !== "Prepared") {
      return { decision: "refuse", reasons: [`operation state is ${operation.state}, expected Prepared`] };
    }
    const recomputed = !sponsored ? digestVaultTransaction(operation)
      : sponsored.approval ? digestSponsoredBatch(operation, sponsored.wallet, sponsored.deadline, sponsored.approval)
      : digestSponsoredExecute(operation, sponsored.wallet, sponsored.deadline);
    if (recomputed !== bytes32ToHex(operation.tx_digest)) {
      return { decision: "refuse", reasons: [sponsored ? "Vault tx_digest does not match the wallet's EIP-712 Execute" : "Vault tx_digest does not match canonical EIP-1559 transaction"] };
    }
    const decision = evaluateOperation(context, operation);
    if (decision.decision === "refuse") return decision;
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
    const signature = await signDomainPayload("mandateos:visa:v1", serializeVisa(visa), this.visaSigner);
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
      this.statusSigner,
    );
    return { report, signature };
  }

}
