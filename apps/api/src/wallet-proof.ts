import { createHash, randomBytes, randomUUID } from "node:crypto";

import { verifySignature } from "@near-wallet-selector/core";
import type { PrismaClient } from "@mandateos/db";
import { getAddress, recoverMessageAddress, type Hex } from "viem";

import type { NearClient } from "./near.js";

export interface WalletProofChallengeView {
  id: string;
  memberId: string;
  nearAccountId: string;
  evmAddress: string;
  message: string;
  nonceBase64: string;
  recipient: string;
  expiresAt: string;
}

export interface WalletProofSubmission {
  challengeId: string;
  nearAccountId: string;
  nearPublicKey: string;
  nearSignature: string;
  evmAddress: string;
  evmSignature: string;
}

export interface WalletProofGateway {
  createChallenge(
    userId: string,
    input: { memberId: string; nearAccountId: string; evmAddress: string },
  ): Promise<WalletProofChallengeView>;
  verify(userId: string, input: WalletProofSubmission): Promise<{ memberId: string; organizationId: string }>;
}

export class WalletProofError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function proofMessage(input: {
  memberId: string;
  organizationId: string;
  nearAccountId: string;
  evmAddress: string;
  nonceBase64: string;
  recipient: string;
  evmChainId: number;
  expiresAt: Date;
}): string {
  return [
    "MandateOS wallet ownership proof",
    "version: 1",
    `member_id: ${input.memberId}`,
    `organization_id: ${input.organizationId}`,
    `near_account_id: ${input.nearAccountId}`,
    `evm_address: ${input.evmAddress}`,
    `near_recipient: ${input.recipient}`,
    `evm_chain_id: ${input.evmChainId}`,
    `nonce: ${input.nonceBase64}`,
    `expires_at: ${input.expiresAt.toISOString()}`,
  ].join("\n");
}

function hasFullAccessKey(keys: unknown[], publicKey: string): boolean {
  return keys.some((entry) => {
    if (!entry || typeof entry !== "object" || !("public_key" in entry) || !("access_key" in entry)) return false;
    if (entry.public_key !== publicKey) return false;
    const accessKey = entry.access_key;
    return Boolean(
      accessKey &&
      typeof accessKey === "object" &&
      "permission" in accessKey &&
      accessKey.permission === "FullAccess",
    );
  });
}

export class WalletProofService implements WalletProofGateway {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly recipient: string,
    private readonly evmChainId: number,
    private readonly allowDeterministicUnfundedWallets = false,
  ) {}

  async createChallenge(
    userId: string,
    input: { memberId: string; nearAccountId: string; evmAddress: string },
  ): Promise<WalletProofChallengeView> {
    const member = await this.prisma.member.findUnique({ where: { id: input.memberId } });
    if (!member) throw new WalletProofError(404, "member_not_found", "member not found");
    if (member.userId !== userId && !member.walletProofClaimable) {
      throw new WalletProofError(403, "member_not_claimable", "member cannot be claimed by this profile");
    }

    const evmAddress = getAddress(input.evmAddress);
    if (member.walletProofClaimable) {
      if (member.nearAccountId !== input.nearAccountId || getAddress(member.evmAddress ?? "") !== evmAddress) {
        throw new WalletProofError(422, "declared_wallet_mismatch", "proof wallets do not match the admin declaration");
      }
    }

    const id = randomUUID();
    const nonceBase64 = randomBytes(32).toString("base64");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const message = proofMessage({
      memberId: member.id,
      organizationId: member.organizationId,
      nearAccountId: input.nearAccountId,
      evmAddress,
      nonceBase64,
      recipient: this.recipient,
      evmChainId: this.evmChainId,
      expiresAt,
    });

    await this.prisma.$transaction([
      this.prisma.walletProofChallenge.deleteMany({
        where: { memberId: member.id, consumedAt: null },
      }),
      this.prisma.walletProofChallenge.create({
        data: {
          id,
          memberId: member.id,
          userId,
          nearAccountId: input.nearAccountId,
          evmAddress,
          message,
          nonceBase64,
          recipient: this.recipient,
          expiresAt,
        },
      }),
    ]);

    return {
      id,
      memberId: member.id,
      nearAccountId: input.nearAccountId,
      evmAddress,
      message,
      nonceBase64,
      recipient: this.recipient,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verify(userId: string, input: WalletProofSubmission): Promise<{ memberId: string; organizationId: string }> {
    const challenge = await this.prisma.walletProofChallenge.findUnique({
      where: { id: input.challengeId },
      include: { member: true },
    });
    if (!challenge) throw new WalletProofError(404, "challenge_not_found", "wallet proof challenge not found");
    if (challenge.userId !== userId) throw new WalletProofError(403, "challenge_owner_mismatch", "challenge belongs to another profile");
    if (challenge.consumedAt) throw new WalletProofError(409, "challenge_consumed", "wallet proof challenge was already consumed");
    if (challenge.expiresAt.getTime() <= Date.now()) throw new WalletProofError(410, "challenge_expired", "wallet proof challenge expired");

    const evmAddress = getAddress(input.evmAddress);
    if (challenge.nearAccountId !== input.nearAccountId || challenge.evmAddress !== evmAddress) {
      throw new WalletProofError(422, "challenge_wallet_mismatch", "submitted wallets do not match the challenge");
    }

    const nonce = Buffer.from(challenge.nonceBase64, "base64");
    let validNearSignature = false;
    try {
      validNearSignature = verifySignature({
        publicKey: input.nearPublicKey,
        signature: input.nearSignature,
        message: challenge.message,
        nonce,
        recipient: challenge.recipient,
      });
    } catch {
      validNearSignature = false;
    }
    if (!validNearSignature) {
      throw new WalletProofError(422, "near_signature_invalid", "invalid NEP-413 signature");
    }
    let nearKeyAuthorized = false;
    try {
      const accessKeys = await this.near.getAccessKeys(challenge.nearAccountId);
      nearKeyAuthorized = hasFullAccessKey(accessKeys.keys, input.nearPublicKey);
    } catch {
      // A missing deterministic UAT account may be reported as an RPC error.
    }
    if (!nearKeyAuthorized && this.allowDeterministicUnfundedWallets) {
      const suffix = createHash("sha256").update(input.nearPublicKey).digest("hex").slice(0, 12);
      nearKeyAuthorized = challenge.nearAccountId === `w-${suffix}.${this.recipient}`;
    }
    if (!nearKeyAuthorized) {
      throw new WalletProofError(
        422,
        "near_key_not_authorized",
        "NEP-413 signer is not a full-access key on the NEAR account",
      );
    }

    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message: challenge.message,
        signature: input.evmSignature as Hex,
      });
    } catch {
      throw new WalletProofError(422, "evm_signature_invalid", "invalid EIP-191 signature");
    }
    if (getAddress(recovered) !== evmAddress) {
      throw new WalletProofError(422, "evm_signer_mismatch", "EIP-191 signer does not match the declared address");
    }

    await this.prisma.$transaction(async (transaction) => {
      const fresh = await transaction.walletProofChallenge.findUnique({
        where: { id: challenge.id },
        include: { member: true },
      });
      if (!fresh || fresh.consumedAt) {
        throw new WalletProofError(409, "challenge_consumed", "wallet proof challenge was already consumed");
      }
      if (fresh.expiresAt.getTime() <= Date.now()) {
        throw new WalletProofError(410, "challenge_expired", "wallet proof challenge expired");
      }
      if (fresh.member.userId !== userId && !fresh.member.walletProofClaimable) {
        throw new WalletProofError(403, "member_not_claimable", "member cannot be claimed by this profile");
      }
      const duplicateMembership = await transaction.member.findFirst({
        where: {
          organizationId: fresh.member.organizationId,
          userId,
          id: { not: fresh.member.id },
        },
        select: { id: true },
      });
      if (duplicateMembership) {
        throw new WalletProofError(409, "membership_exists", "profile already belongs to this organization");
      }

      const previousUserId = fresh.member.userId;
      await transaction.member.update({
        where: { id: fresh.member.id },
        data: {
          userId,
          nearAccountId: fresh.nearAccountId,
          evmAddress: fresh.evmAddress,
          walletProofClaimable: false,
          walletProofVerifiedAt: new Date(),
          walletProofMessage: fresh.message,
          nearProofPublicKey: input.nearPublicKey,
          nearProofSignature: input.nearSignature,
          evmProofSignature: input.evmSignature,
        },
      });
      await transaction.walletProofChallenge.update({
        where: { id: fresh.id },
        data: { consumedAt: new Date() },
      });
      if (fresh.member.walletProofClaimable && previousUserId !== userId) {
        await transaction.user.delete({ where: { id: previousUserId } });
      }
    }, { isolationLevel: "Serializable" });

    return { memberId: challenge.memberId, organizationId: challenge.member.organizationId };
  }
}
