import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildBaseTreasuryPlan, type BaseTreasuryPlan } from "@mandateos/deployer";
import type { PrismaClient } from "@mandateos/db";
import bs58 from "bs58";
import { createPublicClient, getAddress, http, keccak256, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";

export interface TreasuryConfig {
  nearNetwork: string;
  daoFactoryId: string;
  mpcContractId: string;
  mpcPath: string;
  baseRpcUrl: string;
  budgetTokenAccountId: string;
  artifactsDir: string;
  baseChainId: number;
  vaultTtlBlocks: number;
  vaultDepositYocto: string;
  relayDepositYocto: string;
  daoCreateDepositYocto: string;
}

export interface NearAction {
  type: "CreateAccount" | "Transfer" | "DeployContract" | "FunctionCall";
  depositYocto?: string;
  codeBase64?: string;
  methodName?: string;
  args?: Record<string, unknown>;
  gasTgas?: number;
  description: string;
}

export interface NearContractPlan {
  accountId: string;
  initMethod: "new";
  initArgs: Record<string, unknown>;
  wasmSha256: string;
  actions: NearAction[];
}

export interface TreasuryPlan {
  organizationId: string;
  environment: string;
  nearNetwork: string;
  baseChainId: number;
  daoAccountId: string;
  council: Array<{ memberId: string; nearAccountId: string; evmAddress: Address }>;
  threshold: number;
  policy: Record<string, unknown>;
  daoCreate: {
    factoryId: string;
    method: "create";
    args: { name: string; args: string };
    depositYocto: string;
    description: string;
  };
  vault: NearContractPlan;
  relay: NearContractPlan;
  govAddress: Address;
  base: BaseTreasuryPlan;
}

export interface RegisterTreasuryInput {
  environment: string;
  daoAccountId: string;
  vaultAccountId: string;
  relayAccountId: string;
  safeAddress: string;
  rolesAddress: string;
  delayAddress: string;
  govAddress: string;
}

export interface TreasuryView {
  organizationId: string;
  environment: string;
  nearNetwork: string;
  baseChainId: number;
  daoAccountId: string;
  vaultAccountId: string;
  relayAccountId: string;
  safeAddress: string;
  rolesAddress: string;
  delayAddress: string;
  govAddress: string;
  status: string;
}

export type BaseTreasuryPlanner = (input: {
  organizationId: string;
  slug: string;
  owners: Address[];
  threshold: number;
  govAddress: Address;
  rpcUrl: string;
}) => Promise<BaseTreasuryPlan>;

export interface BaseTreasuryVerifier {
  verify(input: {
    owners: Address[];
    threshold: bigint;
    safeAddress: Address;
    rolesAddress: Address;
    delayAddress: Address;
    govAddress: Address;
  }): Promise<void>;
}

export interface TreasuryGateway {
  linkWallets(organizationId: string, userId: string, input: { nearAccountId: string; evmAddress: string }): Promise<void>;
  plan(organizationId: string, input: { environment: string; daoName: string; founderNearAccountId: string }): Promise<TreasuryPlan>;
  register(organizationId: string, actorId: string, input: RegisterTreasuryInput): Promise<TreasuryView>;
  getTreasury(organizationId: string, environment: string): Promise<TreasuryView | null>;
}

export class TreasuryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 500,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Artifact {
  base64: string;
  sha256: string;
}

interface TreasuryMember {
  id: string;
  nearAccountId: string | null;
  evmAddress: string | null;
}

const safeAbi = [
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getModules", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "isModuleEnabled", stateMutability: "view", inputs: [{ name: "module", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

const delayAbi = [
  { type: "function", name: "modules", stateMutability: "view", inputs: [{ name: "module", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "txCooldown", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "txExpiration", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const rolesAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "avatar", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "target", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (slug.length < 2) throw new TreasuryError(400, "invalid_dao_name", "daoName must contain at least two letters or digits");
  return slug;
}

function nearPublicKeyToEvmAddress(publicKey: string): Address {
  const encoded = publicKey.startsWith("secp256k1:") ? publicKey.slice("secp256k1:".length) : publicKey;
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(encoded);
  } catch {
    throw new TreasuryError(422, "invalid_mpc_public_key", "MPC returned an invalid public key");
  }
  if (decoded.length !== 64) throw new TreasuryError(422, "invalid_mpc_public_key", "MPC public key must be 64 bytes");
  const hash = keccak256(decoded);
  return getAddress(`0x${hash.slice(-40)}`);
}

async function loadArtifact(directory: string, name: string): Promise<Artifact> {
  const candidates = [
    resolve(directory, name),
    resolve(process.cwd(), "contracts/res", name),
    resolve(process.cwd(), "../../contracts/res", name),
  ];
  for (const candidate of candidates) {
    try {
      const wasm = await readFile(candidate);
      return {
        base64: wasm.toString("base64"),
        sha256: createHash("sha256").update(wasm).digest("hex"),
      };
    } catch {
      // try the next candidate
    }
  }
  throw new TreasuryError(500, "artifact_missing", `cannot read ${name}`);
}

export class RpcBaseTreasuryVerifier implements BaseTreasuryVerifier {
  private readonly client;

  constructor(rpcUrl: string) {
    this.client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  }

  async verify(input: {
    owners: Address[];
    threshold: bigint;
    safeAddress: Address;
    rolesAddress: Address;
    delayAddress: Address;
    govAddress: Address;
  }): Promise<void> {
    const { safe, roles, delay, gov, owners, threshold } = {
      safe: input.safeAddress,
      roles: input.rolesAddress,
      delay: input.delayAddress,
      gov: input.govAddress,
      owners: input.owners,
      threshold: input.threshold,
    };
    for (const address of [safe, roles, delay]) {
      const code = await this.client.getBytecode({ address });
      if (!code || code === "0x") throw new TreasuryError(422, "missing_contract", `${address} has no code`);
    }
    const chainOwners = (await this.client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }))
      .map((owner) => owner.toLowerCase())
      .sort();
    if (JSON.stringify(chainOwners) !== JSON.stringify(owners.map((owner) => owner.toLowerCase()).sort())) {
      throw new TreasuryError(422, "safe_owners_mismatch", "Safe owners do not match the council");
    }
    const chainThreshold = await this.client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" });
    if (chainThreshold !== threshold) throw new TreasuryError(422, "safe_threshold_mismatch", "Safe threshold is incorrect");
    const rolesEnabled = await this.client.readContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [roles] });
    const delayEnabled = await this.client.readContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [delay] });
    if (!rolesEnabled || !delayEnabled) throw new TreasuryError(422, "modules_disabled", "Roles and Delay must be enabled");
    const govEnabled = await this.client.readContract({ address: delay, abi: delayAbi, functionName: "modules", args: [gov] });
    if (!govEnabled) throw new TreasuryError(422, "gov_not_enabled", "0xGOV is not enabled on Delay");
    const cooldown = await this.client.readContract({ address: delay, abi: delayAbi, functionName: "txCooldown" });
    const expiration = await this.client.readContract({ address: delay, abi: delayAbi, functionName: "txExpiration" });
    if (cooldown !== 300n || expiration !== 604_800n) throw new TreasuryError(422, "delay_policy_mismatch", "Delay cooldown or expiration is incorrect");
    const rolesOwner = getAddress(await this.client.readContract({ address: roles, abi: rolesAbi, functionName: "owner" }));
    const rolesAvatar = getAddress(await this.client.readContract({ address: roles, abi: rolesAbi, functionName: "avatar" }));
    const rolesTarget = getAddress(await this.client.readContract({ address: roles, abi: rolesAbi, functionName: "target" }));
    if (rolesOwner !== safe || rolesAvatar !== safe || rolesTarget !== safe) {
      throw new TreasuryError(422, "roles_wiring_mismatch", "Roles owner, avatar and target must be the Safe");
    }
  }
}

export class TreasuryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly signer: KmsSigner,
    private readonly config: TreasuryConfig,
    private readonly basePlanner: BaseTreasuryPlanner = buildBaseTreasuryPlan,
    private readonly baseVerifier: BaseTreasuryVerifier = new RpcBaseTreasuryVerifier(config.baseRpcUrl),
  ) {}

  async linkWallets(
    organizationId: string,
    userId: string,
    input: { nearAccountId: string; evmAddress: string },
  ): Promise<void> {
    const member = await this.prisma.member.findFirst({ where: { organizationId, userId } });
    if (!member) throw new TreasuryError(404, "member_not_found", "membership not found");
    const evmAddress = getAddress(input.evmAddress);
    await this.prisma.member.update({
      where: { id: member.id },
      data: { nearAccountId: input.nearAccountId, evmAddress },
    });
  }

  async getTreasury(organizationId: string, environment: string): Promise<TreasuryView | null> {
    const treasury = await this.prisma.treasury.findUnique({
      where: { organizationId_environment: { organizationId, environment } },
    });
    return treasury ? this.toView(treasury) : null;
  }

  async plan(organizationId: string, input: { environment: string; daoName: string; founderNearAccountId: string }): Promise<TreasuryPlan> {
    const members = (await this.prisma.member.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
    })) as TreasuryMember[];
    if (members.length === 0) throw new TreasuryError(409, "no_members", "organization has no members");
    if (members.some((member) => !member.nearAccountId || !member.evmAddress)) {
      throw new TreasuryError(409, "member_wallets_missing", "every member must link a NEAR and an EVM wallet");
    }
    const council = members.map((member) => ({
      memberId: member.id,
      nearAccountId: member.nearAccountId as string,
      evmAddress: getAddress(member.evmAddress as string),
    }));
    if (!council.some((member) => member.nearAccountId === input.founderNearAccountId)) {
      throw new TreasuryError(400, "founder_not_in_council", "founderNearAccountId must be a council member");
    }

    const slug = slugify(input.daoName);
    const daoAccountId = `${slug}.${this.config.daoFactoryId}`;
    const vaultAccountId = `${slug}-vault.${input.founderNearAccountId}`;
    const relayAccountId = `${slug}-relay.${input.founderNearAccountId}`;
    for (const accountId of [daoAccountId, vaultAccountId, relayAccountId]) {
      if (accountId.length > 64) throw new TreasuryError(400, "account_id_too_long", `${accountId} exceeds 64 characters`);
    }

    const threshold = Math.ceil((2 * council.length) / 3);
    const policy = {
      roles: [
        {
          name: "council",
          kind: { Group: council.map((member) => member.nearAccountId) },
          permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
          vote_policy: {},
        },
      ],
      default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: String(threshold) },
      proposal_bond: "100000000000000000000000",
      proposal_period: "604800000000000",
      bounty_bond: "100000000000000000000000",
      bounty_forgiveness_period: "604800000000000",
    };
    const daoInitArgs = {
      config: { name: `${input.daoName} MandateOS DAO`, purpose: "Govern the MandateOS treasury", metadata: "" },
      policy,
    };

    const govPublicKey = await this.near.derivedPublicKey(
      this.config.mpcContractId,
      relayAccountId,
      this.config.mpcPath,
      0,
    );
    const govAddress = nearPublicKeyToEvmAddress(govPublicKey);
    const guardPublicKey = Buffer.from(await this.signer.publicKey()).toString("base64");

    const vaultArtifact = await loadArtifact(this.config.artifactsDir, "vault.wasm");
    const relayArtifact = await loadArtifact(this.config.artifactsDir, "governance_relay.wasm");
    const vaultInitArgs = {
      client_id: slug,
      owner_id: daoAccountId,
      token_id: this.config.budgetTokenAccountId,
      mpc_contract_id: this.config.mpcContractId,
      evm_chain_id: this.config.baseChainId,
      guard_public_key: guardPublicKey,
      policy_version: 1,
      registry_version: 1,
      reservation_ttl_blocks: this.config.vaultTtlBlocks,
    };
    const relayInitArgs = {
      owner_id: daoAccountId,
      mpc_contract_id: this.config.mpcContractId,
      mpc_path: this.config.mpcPath,
      evm_chain_id: this.config.baseChainId,
      delay_address: Buffer.from(govAddress.slice(2), "hex").toString("base64"),
      max_gas_limit: "300000",
      max_fee_per_gas: "100000000000",
      max_priority_fee_per_gas: "10000000000",
      max_total_fee: "30000000000000000",
    };

    const base = await this.basePlanner({
      organizationId,
      slug,
      owners: council.map((member) => member.evmAddress),
      threshold,
      govAddress,
      rpcUrl: this.config.baseRpcUrl,
    });

    const nearDeployment = (accountId: string, artifact: Artifact, initArgs: Record<string, unknown>, depositYocto: string): NearContractPlan => ({
      accountId,
      initMethod: "new",
      initArgs,
      wasmSha256: artifact.sha256,
      actions: [
        { type: "CreateAccount", description: `Create ${accountId}` },
        { type: "Transfer", depositYocto, description: `Fund ${accountId} storage and gas` },
        { type: "DeployContract", codeBase64: artifact.base64, description: `Deploy ${artifact.sha256}` },
        { type: "FunctionCall", methodName: "new", args: initArgs, gasTgas: 100, description: `Initialize ${accountId}` },
      ],
    });

    return {
      organizationId,
      environment: input.environment,
      nearNetwork: this.config.nearNetwork,
      baseChainId: this.config.baseChainId,
      daoAccountId,
      council,
      threshold,
      policy,
      daoCreate: {
        factoryId: this.config.daoFactoryId,
        method: "create",
        args: { name: slug, args: Buffer.from(JSON.stringify(daoInitArgs)).toString("base64") },
        depositYocto: this.config.daoCreateDepositYocto,
        description: `Create Sputnik DAO ${daoAccountId}`,
      },
      vault: nearDeployment(vaultAccountId, vaultArtifact, vaultInitArgs, this.config.vaultDepositYocto),
      relay: nearDeployment(relayAccountId, relayArtifact, relayInitArgs, this.config.relayDepositYocto),
      govAddress,
      base,
    };
  }

  async register(organizationId: string, actorId: string, input: RegisterTreasuryInput): Promise<TreasuryView> {
    const members = (await this.prisma.member.findMany({ where: { organizationId } })) as TreasuryMember[];
    if (members.some((member) => !member.nearAccountId || !member.evmAddress)) {
      throw new TreasuryError(409, "member_wallets_missing", "every member must link a NEAR and an EVM wallet");
    }
    const expectedOwners = members.map((member) => getAddress(member.evmAddress as string).toLowerCase()).sort();
    const expectedThreshold = BigInt(Math.ceil((2 * members.length) / 3));
    const vaultArtifact = await loadArtifact(this.config.artifactsDir, "vault.wasm");
    const relayArtifact = await loadArtifact(this.config.artifactsDir, "governance_relay.wasm");

    await this.verifyNearAccount(input.daoAccountId, null);
    await this.verifyNearAccount(input.vaultAccountId, vaultArtifact.sha256);
    await this.verifyNearAccount(input.relayAccountId, relayArtifact.sha256);
    const vaultOwner = await this.near.viewFunction<string>(input.vaultAccountId, "owner_id");
    const relayOwner = await this.near.viewFunction<string>(input.relayAccountId, "owner_id");
    if (vaultOwner !== input.daoAccountId) throw new TreasuryError(422, "vault_owner_mismatch", "Vault owner is not the DAO");
    if (relayOwner !== input.daoAccountId) throw new TreasuryError(422, "relay_owner_mismatch", "relay owner is not the DAO");
    const relayGov = await this.near.viewFunction<string>(input.relayAccountId, "evm_address");
    const relayGovHex = `0x${Buffer.from(relayGov, "base64").toString("hex")}`;
    if (getAddress(relayGovHex) !== getAddress(input.govAddress)) {
      throw new TreasuryError(422, "gov_mismatch", "relay does not derive the registered 0xGOV");
    }

    const safe = getAddress(input.safeAddress);
    const roles = getAddress(input.rolesAddress);
    const delay = getAddress(input.delayAddress);
    await this.baseVerifier.verify({
      owners: members.map((member) => getAddress(member.evmAddress as string)),
      threshold: expectedThreshold,
      safeAddress: safe,
      rolesAddress: roles,
      delayAddress: delay,
      govAddress: getAddress(input.govAddress),
    });

    const treasury = await this.prisma.treasury.create({
      data: {
        organizationId,
        environment: input.environment,
        nearNetwork: this.config.nearNetwork,
        baseChainId: this.config.baseChainId,
        daoAccountId: input.daoAccountId,
        vaultAccountId: input.vaultAccountId,
        relayAccountId: input.relayAccountId,
        safeAddress: safe,
        rolesAddress: roles,
        delayAddress: delay,
        govAddress: getAddress(input.govAddress),
        vaultWasmSha256: vaultArtifact.sha256,
        relayWasmSha256: relayArtifact.sha256,
        status: "active",
      },
    }).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        throw new TreasuryError(409, "treasury_exists", "a treasury is already registered for this environment");
      }
      throw error;
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorType: "console",
        actorId,
        action: "treasury.registered",
        targetType: "treasury",
        targetId: treasury.id,
        metadata: { daoAccountId: input.daoAccountId, safeAddress: safe },
      },
    });
    return this.toView(treasury);
  }

  private async verifyNearAccount(accountId: string, expectedSha256: string | null): Promise<void> {
    const account = await this.near.getAccount(accountId);
    if (expectedSha256) {
      const expected = bs58.encode(Buffer.from(expectedSha256, "hex"));
      if (account.code_hash !== expected) throw new TreasuryError(422, "wasm_hash_mismatch", `${accountId} code hash does not match`);
      const accessKeys = await this.near.getAccessKeys(accountId);
      if (accessKeys.keys.length !== 0) throw new TreasuryError(422, "access_key_present", `${accountId} still has an access key`);
    }
  }

  private toView(treasury: {
    organizationId: string;
    environment: string;
    nearNetwork: string;
    baseChainId: number;
    daoAccountId: string;
    vaultAccountId: string;
    relayAccountId: string;
    safeAddress: string;
    rolesAddress: string;
    delayAddress: string;
    govAddress: string;
    status: string;
  }): TreasuryView {
    return {
      organizationId: treasury.organizationId,
      environment: treasury.environment,
      nearNetwork: treasury.nearNetwork,
      baseChainId: treasury.baseChainId,
      daoAccountId: treasury.daoAccountId,
      vaultAccountId: treasury.vaultAccountId,
      relayAccountId: treasury.relayAccountId,
      safeAddress: treasury.safeAddress,
      rolesAddress: treasury.rolesAddress,
      delayAddress: treasury.delayAddress,
      govAddress: treasury.govAddress,
      status: treasury.status,
    };
  }
}
