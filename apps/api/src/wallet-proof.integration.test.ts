import { createHash, randomUUID } from "node:crypto";

import { serializeNep413 } from "@near-wallet-selector/core";
import { PrismaClient } from "@mandateos/db";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import type { NearClient } from "./near.js";
import { WalletProofService } from "./wallet-proof.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

function nearProof(challenge: {
  message: string;
  nonceBase64: string;
  recipient: string;
}, keyPair: KeyPair): string {
  const payload = serializeNep413({
    message: challenge.message,
    nonce: Buffer.from(challenge.nonceBase64, "base64"),
    recipient: challenge.recipient,
  });
  const digest = createHash("sha256").update(payload).digest();
  return Buffer.from(keyPair.sign(digest).signature).toString("base64");
}

describe.skipIf(!databaseUrl)("wallet ownership proofs against PostgreSQL", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("claims an admin-declared member only after valid NEP-413 and EIP-191 proofs", async () => {
    const organizationId = randomUUID();
    const pendingUserId = randomUUID();
    const claimantUserId = randomUUID();
    const memberId = randomUUID();
    const nearKey = KeyPair.fromRandom("ed25519");
    const nearPublicKey = nearKey.getPublicKey().toString();
    const nearAccountId = `proof-${randomUUID().slice(0, 8)}.testnet`;
    const evm = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

    await prisma.organization.create({
      data: { id: organizationId, name: "Proof Org", slug: `proof-${organizationId}`, createdAt: new Date() },
    });
    await prisma.user.createMany({
      data: [
        { id: pendingUserId, name: "Pending", email: `pending-${pendingUserId}@members.mandateos.invalid`, emailVerified: false },
        { id: claimantUserId, name: "Claimant", email: `claimant-${claimantUserId}@example.test`, emailVerified: false },
      ],
    });
    await prisma.member.create({
      data: {
        id: memberId,
        organizationId,
        userId: pendingUserId,
        role: "member",
        nearAccountId,
        evmAddress: evm.address,
        walletProofClaimable: true,
        createdAt: new Date(),
      },
    });

    const near = {
      getAccessKeys: async () => ({
        keys: [{ public_key: nearPublicKey, access_key: { permission: "FullAccess" } }],
      }),
    } as unknown as NearClient;
    const service = new WalletProofService(prisma, near, "mandateos.testnet", 84532);
    const challenge = await service.createChallenge(claimantUserId, {
      memberId,
      nearAccountId,
      evmAddress: evm.address,
    });
    expect(challenge.message).toContain(`member_id: ${memberId}`);
    expect(challenge.message).toContain("evm_chain_id: 84532");

    const result = await service.verify(claimantUserId, {
      challengeId: challenge.id,
      nearAccountId,
      nearPublicKey,
      nearSignature: nearProof(challenge, nearKey),
      evmAddress: evm.address,
      evmSignature: await evm.signMessage({ message: challenge.message }),
    });
    expect(result).toEqual({ memberId, organizationId });
    await expect(prisma.member.findUnique({ where: { id: memberId } })).resolves.toMatchObject({
      userId: claimantUserId,
      walletProofClaimable: false,
      nearProofPublicKey: nearPublicKey,
      walletProofVerifiedAt: expect.any(Date),
    });
    await expect(service.verify(claimantUserId, {
      challengeId: challenge.id,
      nearAccountId,
      nearPublicKey,
      nearSignature: nearProof(challenge, nearKey),
      evmAddress: evm.address,
      evmSignature: await evm.signMessage({ message: challenge.message }),
    })).rejects.toMatchObject({ code: "challenge_consumed" });

    const secondChallenge = await service.createChallenge(claimantUserId, {
      memberId,
      nearAccountId,
      evmAddress: evm.address,
    });
    const otherEvm = privateKeyToAccount("0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    await expect(service.verify(claimantUserId, {
      challengeId: secondChallenge.id,
      nearAccountId,
      nearPublicKey,
      nearSignature: nearProof(secondChallenge, nearKey),
      evmAddress: evm.address,
      evmSignature: await otherEvm.signMessage({ message: secondChallenge.message }),
    })).rejects.toMatchObject({ code: "evm_signer_mismatch" });

    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: claimantUserId } });
  });

  it("accepts an unfunded deterministic demo account only when the server flag is enabled", async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const memberId = randomUUID();
    const nearKey = KeyPair.fromRandom("ed25519");
    const nearPublicKey = nearKey.getPublicKey().toString();
    const suffix = createHash("sha256").update(nearPublicKey).digest("hex").slice(0, 12);
    const nearAccountId = `w-${suffix}.mandateos.testnet`;
    const evm = privateKeyToAccount("0x1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    await prisma.organization.create({
      data: { id: organizationId, name: "Demo Proof Org", slug: `demo-proof-${organizationId}`, createdAt: new Date() },
    });
    await prisma.user.create({
      data: { id: userId, name: "Demo", email: `demo-${userId}@example.test`, emailVerified: false },
    });
    await prisma.member.create({
      data: {
        id: memberId,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const unavailableNear = {
      getAccessKeys: async () => ({ keys: [] }),
    } as unknown as NearClient;
    const service = new WalletProofService(prisma, unavailableNear, "mandateos.testnet", 84532, true);
    const challenge = await service.createChallenge(userId, { memberId, nearAccountId, evmAddress: evm.address });
    await expect(service.verify(userId, {
      challengeId: challenge.id,
      nearAccountId,
      nearPublicKey,
      nearSignature: nearProof(challenge, nearKey),
      evmAddress: evm.address,
      evmSignature: await evm.signMessage({ message: challenge.message }),
    })).resolves.toEqual({ memberId, organizationId });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
  });
});
