import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildBaseTreasuryPlan, canonicalMultiSendCallOnlyAddress, type BaseTreasuryPlan } from "@mandateos/deployer";
import type { PrismaClient } from "@mandateos/db";
import bs58 from "bs58";
import { createPublicClient, getAddress, http, keccak256, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";

export interface TreasuryEnvironmentConfig {
  baseChainId: number;
  baseRpcUrl: string;
  delayCooldownSeconds: bigint;
  delayExpirationSeconds: bigint;
}

export interface TreasuryConfig {
  nearNetwork: string;
  daoFactoryId: string;
  mpcContractId: string;
  mpcPath: string;
  budgetTokenAccountId: string;
  artifactsDir: string;
  accountParent: string;
  environments: Record<string, TreasuryEnvironmentConfig>;
  vaultTtlBlocks: number;
  vaultDepositYocto: string;
  relayDepositYocto: string;
  daoCreateDepositYocto: string;
  baseGasCaps: {
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  };
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
  daoName: string;
  founderNearAccountId: string;
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

export interface NearDeploymentAttestationInput {
  environment: string;
  daoAccountId: string;
  vaultAccountId: string;
  delayAddress: string;
  relayAccountId: string;
  govAddress: string;
}

export interface NearDeploymentConfirmationStatus {
  digest: string;
  confirmedMemberIds: string[];
  requiredMemberIds: string[];
}

interface VerifiedTreasury {
  environment: TreasuryEnvironmentConfig;
  status: string;
  safe: Address;
  roles: Address;
  delay: Address;
  gov: Address;
  vaultWasmSha256: string;
  relayWasmSha256: string;
  warnings: string[];
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
  chainId: number;
}) => Promise<BaseTreasuryPlan>;

export function assertDelayPolicy(
  cooldown: bigint,
  expiration: bigint,
  expectedCooldown: bigint,
  expectedExpiration: bigint,
): void {
  if (cooldown !== expectedCooldown || expiration !== expectedExpiration) {
    throw new TreasuryError(422, "delay_policy_mismatch", "Delay cooldown or expiration is incorrect");
  }
}

export interface BaseTreasuryVerifier {
  verify(input: {
    owners: Address[];
    threshold: bigint;
    safeAddress: Address;
    rolesAddress: Address;
    delayAddress: Address;
    govAddress: Address;
    delayCooldownSeconds: bigint;
    multiSendAddress: Address;
    delayExpirationSeconds: bigint;
  }): Promise<void>;
}

export interface TreasuryGateway {
  plan(organizationId: string, input: { environment: string; daoName: string; founderNearAccountId: string }): Promise<TreasuryPlan>;
  register(organizationId: string, actorId: string, input: RegisterTreasuryInput): Promise<TreasuryView>;
  deployContracts(
    organizationId: string,
    input: { environment: string; daoName: string; founderNearAccountId: string },
  ): Promise<{ vaultTxHash: string; relayTxHash: string }>;
  confirmNearDeployment(
    organizationId: string,
    memberId: string,
    input: NearDeploymentAttestationInput,
  ): Promise<NearDeploymentConfirmationStatus>;
  nearDeploymentConfirmations(
    organizationId: string,
    input: NearDeploymentAttestationInput,
  ): Promise<NearDeploymentConfirmationStatus>;
  refresh(organizationId: string, actorId: string, environment: string): Promise<TreasuryView>;
  getTreasury(organizationId: string, environment: string): Promise<TreasuryView | null>;
}

type WeightOrRatio = string | number | [number, number];

interface VotePolicy {
  weight_kind?: string;
  quorum?: WeightOrRatio;
  threshold?: WeightOrRatio;
}

interface SputnikPolicy {
  roles?: Array<{
    name?: string;
    kind?: unknown;
    permissions?: string[];
    vote_policy?: Record<string, VotePolicy>;
  }>;
  default_vote_policy?: VotePolicy;
}

function requiredVotes(value: WeightOrRatio | undefined, councilSize: number): bigint | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    const [numerator, denominator] = value;
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) return null;
    return BigInt(Math.floor((numerator * councilSize) / denominator) + 1);
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function assertRoleWeight(policy: VotePolicy | undefined, code: string, label: string): void {
  if (policy?.weight_kind !== "RoleWeight") {
    throw new TreasuryError(422, code, `${label} weight_kind must be RoleWeight`);
  }
  if (policy.quorum === undefined || String(policy.quorum) !== "0") {
    throw new TreasuryError(422, code, `${label} quorum must be 0`);
  }
}

function permissionAction(permission: string): string {
  const separator = permission.indexOf(":");
  return separator === -1 ? permission : permission.slice(separator + 1);
}

interface FactoryInfo {
  factory_id?: string;
  auto_update?: boolean;
}

function isGroupKind(kind: unknown): kind is { Group: string[] } {
  return (
    typeof kind === "object" &&
    kind !== null &&
    "Group" in kind &&
    Array.isArray(kind.Group) &&
    kind.Group.every((member) => typeof member === "string")
  );
}

export class TreasuryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 500,
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
  walletProofVerifiedAt: Date | null;
}

const safeAbi = [
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getModules", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "isModuleEnabled", stateMutability: "view", inputs: [{ name: "module", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

const delayAbi = [
  { type: "function", name: "isModuleEnabled", stateMutability: "view", inputs: [{ name: "module", type: "address" }], outputs: [{ type: "bool" }] },
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

  constructor(
    rpcUrl: string,
    private readonly chainId: number,
  ) {
    this.client = createPublicClient({
      chain: chainId === 8453 ? base : baseSepolia,
      transport: http(rpcUrl),
    });
  }

  async verify(input: {
    owners: Address[];
    threshold: bigint;
    safeAddress: Address;
    rolesAddress: Address;
    delayAddress: Address;
    govAddress: Address;
    multiSendAddress: Address;
    delayCooldownSeconds: bigint;
    delayExpirationSeconds: bigint;
  }): Promise<void> {
    const { safe, roles, delay, gov, multiSend, owners, threshold } = {
      safe: input.safeAddress,
      roles: input.rolesAddress,
      delay: input.delayAddress,
      gov: input.govAddress,
      multiSend: input.multiSendAddress,
      owners: input.owners,
      threshold: input.threshold,
    };
    const canonicalMultiSend = canonicalMultiSendCallOnlyAddress(this.chainId);
    if (multiSend !== canonicalMultiSend) {
      throw new TreasuryError(422, "multisend_address_mismatch", "MultiSend is not the canonical Safe 1.4.1 CallOnly deployment");
    }
    for (const address of [safe, roles, delay, multiSend]) {
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
    const govEnabled = await this.client.readContract({ address: delay, abi: delayAbi, functionName: "isModuleEnabled", args: [gov] });
    if (!govEnabled) throw new TreasuryError(422, "gov_not_enabled", "0xGOV is not enabled on Delay");
    const cooldown = await this.client.readContract({ address: delay, abi: delayAbi, functionName: "txCooldown" });
    const expiration = await this.client.readContract({ address: delay, abi: delayAbi, functionName: "txExpiration" });
    assertDelayPolicy(cooldown, expiration, input.delayCooldownSeconds, input.delayExpirationSeconds);
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
    private readonly baseVerifierFactory: (environment: TreasuryEnvironmentConfig) => BaseTreasuryVerifier = (
      environment,
    ) => new RpcBaseTreasuryVerifier(environment.baseRpcUrl, environment.baseChainId),
  ) {}

  private environment(name: string): TreasuryEnvironmentConfig {
    const environment = this.config.environments[name];
    if (!environment) throw new TreasuryError(400, "unknown_environment", `unknown environment ${name}`);
    return environment;
  }


  async getTreasury(organizationId: string, environment: string): Promise<TreasuryView | null> {
    const treasury = await this.prisma.treasury.findUnique({
      where: { organizationId_environment: { organizationId, environment } },
    });
    return treasury ? this.toView(treasury) : null;
  }

  async plan(organizationId: string, input: { environment: string; daoName: string; founderNearAccountId: string }): Promise<TreasuryPlan> {
    const environment = this.environment(input.environment);
    const members = (await this.prisma.member.findMany({
      where: { organizationId, walletProofVerifiedAt: { not: null } },
      orderBy: { createdAt: "asc" },
    })) as TreasuryMember[];
    if (members.length === 0) {
      throw new TreasuryError(409, "no_proven_members", "organization has no member with both wallet proofs");
    }
    if (members.some((member) => !member.nearAccountId || !member.evmAddress)) {
      throw new TreasuryError(409, "proven_wallets_missing", "a proven member is missing a wallet");
    }
    const council = members.map((member) => ({
      memberId: member.id,
      nearAccountId: member.nearAccountId as string,
      evmAddress: getAddress(member.evmAddress as string),
    }));
    if (!council.some((member) => member.nearAccountId === input.founderNearAccountId)) {
      throw new TreasuryError(400, "founder_not_proven", "founder must prove both wallets before joining the council");
    }

    if (council.length < 3) {
      throw new TreasuryError(409, "council_too_small", "at least three proven council members are required");
    }

    const slug = slugify(input.daoName);
    const daoAccountId = `${slug}.${this.config.daoFactoryId}`;
    const short = slug.slice(0, 8).replace(/-+$/, "");
    const vaultAccountId = `${short}-v.${this.config.accountParent}`;
    const relayAccountId = `${short}-r.${this.config.accountParent}`;
    for (const accountId of [daoAccountId, vaultAccountId, relayAccountId]) {
      if (accountId.length > 64) throw new TreasuryError(400, "account_id_too_long", `${accountId} exceeds 64 characters`);
    }

    const threshold = Math.ceil((2 * council.length) / 3);
    if (threshold >= council.length) {
      throw new TreasuryError(409, "council_no_liveness_margin", "council threshold must be lower than member count");
    }
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
    const base = await this.basePlanner({
      organizationId,
      slug,
      owners: council.map((member) => member.evmAddress),
      threshold,
      govAddress,
      rpcUrl: environment.baseRpcUrl,
      chainId: environment.baseChainId,
    });

    const vaultArtifact = await loadArtifact(this.config.artifactsDir, "vault.wasm");
    const relayArtifact = await loadArtifact(this.config.artifactsDir, "governance_relay.wasm");
    const vaultInitArgs = {
      client_id: slug,
      owner_id: daoAccountId,
      token_id: this.config.budgetTokenAccountId,
      mpc_contract_id: this.config.mpcContractId,
      evm_chain_id: environment.baseChainId,
      guard_public_key: guardPublicKey,
      policy_version: 1,
      registry_version: 1,
      reservation_ttl_blocks: this.config.vaultTtlBlocks,
    };
    const relayInitArgs = {
      client_id: slug,
      owner_id: daoAccountId,
      mpc_contract_id: this.config.mpcContractId,
      mpc_path: this.config.mpcPath,
      evm_chain_id: environment.baseChainId,
      delay_address: Buffer.from(base.delayAddress.slice(2), "hex").toString("base64"),
      multisend_address: Buffer.from(base.multiSendCallOnlyAddress.slice(2), "hex").toString("base64"),
      guard_public_key: guardPublicKey,
      max_gas_limit: this.config.baseGasCaps.gasLimit,
      max_fee_per_gas: this.config.baseGasCaps.maxFeePerGas,
      max_priority_fee_per_gas: this.config.baseGasCaps.maxPriorityFeePerGas,
      max_total_fee: (
        BigInt(this.config.baseGasCaps.gasLimit) * BigInt(this.config.baseGasCaps.maxFeePerGas)
      ).toString(),
    };

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
      baseChainId: environment.baseChainId,
      daoAccountId,
      daoName: slug,
      founderNearAccountId: input.founderNearAccountId,
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


  async deployContracts(
    organizationId: string,
    input: { environment: string; daoName: string; founderNearAccountId: string },
  ): Promise<{ vaultTxHash: string; relayTxHash: string }> {
    const plan = await this.plan(organizationId, input);
    await this.prisma.treasuryDeploymentConfirmation.deleteMany({
      where: { organizationId, environment: input.environment },
    });
    const vaultTxHash = await this.near.executeActions(plan.vault.accountId, plan.vault.actions);
    const relayTxHash = await this.near.executeActions(plan.relay.accountId, plan.relay.actions);
    return { vaultTxHash, relayTxHash };
  }

  async confirmNearDeployment(
    organizationId: string,
    memberId: string,
    input: NearDeploymentAttestationInput,
  ): Promise<NearDeploymentConfirmationStatus> {
    const member = await this.prisma.member.findFirst({
      where: {
        id: memberId,
        organizationId,
        walletProofVerifiedAt: { not: null },
      },
      select: { id: true },
    });
    if (!member) {
      throw new TreasuryError(403, "wallet_proof_required", "member must prove both wallets before confirming deployment");
    }
    const verified = await this.verifyNearDeployment(input);
    await this.prisma.treasuryDeploymentConfirmation.upsert({
      where: {
        organizationId_environment_memberId: {
          organizationId,
          environment: input.environment,
          memberId,
        },
      },
      create: {
        id: randomUUID(),
        organizationId,
        environment: input.environment,
        memberId,
        digest: verified.digest,
      },
      update: {
        digest: verified.digest,
        confirmedAt: new Date(),
      },
    });
    return this.nearDeploymentConfirmationStatus(organizationId, input.environment, verified.digest);
  }

  async nearDeploymentConfirmations(
    organizationId: string,
    input: NearDeploymentAttestationInput,
  ): Promise<NearDeploymentConfirmationStatus> {
    const verified = await this.verifyNearDeployment(input);
    return this.nearDeploymentConfirmationStatus(organizationId, input.environment, verified.digest);
  }

  async register(organizationId: string, actorId: string, input: RegisterTreasuryInput): Promise<TreasuryView> {
    const verified = await this.verify(organizationId, input);
    const treasury = await this.prisma.treasury.create({
      data: {
        organizationId,
        environment: input.environment,
        nearNetwork: this.config.nearNetwork,
        baseChainId: verified.environment.baseChainId,
        daoAccountId: input.daoAccountId,
        vaultAccountId: input.vaultAccountId,
        relayAccountId: input.relayAccountId,
        safeAddress: verified.safe,
        rolesAddress: verified.roles,
        delayAddress: verified.delay,
        govAddress: verified.gov,
        vaultWasmSha256: verified.vaultWasmSha256,
        relayWasmSha256: verified.relayWasmSha256,
        status: verified.status,
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
        metadata: {
          daoAccountId: input.daoAccountId,
          safeAddress: verified.safe,
          status: verified.status,
          warnings: verified.warnings,
        },
      },
    });
    return this.toView(treasury);
  }

  async refresh(organizationId: string, actorId: string, environmentName: string): Promise<TreasuryView> {
    const existing = await this.prisma.treasury.findUnique({
      where: { organizationId_environment: { organizationId, environment: environmentName } },
    });
    if (!existing) throw new TreasuryError(404, "treasury_missing", "no treasury registered for this environment");
    const verified = await this.verify(organizationId, {
      environment: environmentName,
      daoAccountId: existing.daoAccountId,
      vaultAccountId: existing.vaultAccountId,
      relayAccountId: existing.relayAccountId,
      safeAddress: existing.safeAddress,
      rolesAddress: existing.rolesAddress,
      delayAddress: existing.delayAddress,
      govAddress: existing.govAddress,
    }, false);
    const updated = await this.prisma.treasury.update({
      where: { id: existing.id },
      data: {
        status: verified.status,
        vaultWasmSha256: verified.vaultWasmSha256,
        relayWasmSha256: verified.relayWasmSha256,
        safeAddress: verified.safe,
        rolesAddress: verified.roles,
        delayAddress: verified.delay,
        govAddress: verified.gov,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorType: "console",
        actorId,
        action: "treasury.refreshed",
        targetType: "treasury",
        targetId: existing.id,
        metadata: {
          from: existing.status,
          to: verified.status,
          environment: environmentName,
          warnings: verified.warnings,
        },
      },
    });
    return this.toView(updated);
  }

  private async verify(
    organizationId: string,
    input: RegisterTreasuryInput,
    requireConfirmations = true,
  ): Promise<VerifiedTreasury> {
    const environment = this.environment(input.environment);
    const members = (await this.prisma.member.findMany({
      where: { organizationId, walletProofVerifiedAt: { not: null } },
    })) as TreasuryMember[];
    if (members.length === 0) {
      throw new TreasuryError(409, "no_proven_members", "organization has no member with both wallet proofs");
    }
    if (members.some((member) => !member.nearAccountId || !member.evmAddress)) {
      throw new TreasuryError(409, "proven_wallets_missing", "a proven member is missing a wallet");
    }
    if (members.length < 3) {
      throw new TreasuryError(409, "council_too_small", "at least three proven council members are required");
    }
    const expectedThreshold = BigInt(Math.ceil((2 * members.length) / 3));
    if (expectedThreshold >= BigInt(members.length)) {
      throw new TreasuryError(409, "council_no_liveness_margin", "council threshold must be lower than member count");
    }

    const factoryCodeHash = await this.near.viewFunction<string>(this.config.daoFactoryId, "get_default_code_hash");
    const daoAccount = await this.near.getAccount(input.daoAccountId);
    const daoCodeHash = daoAccount.global_contract_hash ?? daoAccount.code_hash;
    if (daoCodeHash !== factoryCodeHash) {
      throw new TreasuryError(422, "dao_code_hash_mismatch", "DAO code hash does not match the factory default");
    }
    const policy = await this.near.viewFunction<SputnikPolicy>(input.daoAccountId, "get_policy");
    this.validateDaoPolicy(policy, members.map((member) => member.nearAccountId as string), expectedThreshold);
    const factoryInfo = await this.near.viewFunction<FactoryInfo>(input.daoAccountId, "get_factory_info");
    const warnings = factoryInfo.auto_update === false ? [] : ["dao_auto_update_enabled"];

    const nearDeployment = await this.verifyNearDeployment({
      environment: input.environment,
      daoAccountId: input.daoAccountId,
      vaultAccountId: input.vaultAccountId,
      relayAccountId: input.relayAccountId,
      delayAddress: input.delayAddress,
      govAddress: input.govAddress,
    });
    if (requireConfirmations) {
      const confirmationStatus = await this.nearDeploymentConfirmationStatus(
        organizationId,
        input.environment,
        nearDeployment.digest,
      );
      const confirmed = new Set(confirmationStatus.confirmedMemberIds);
      if (!confirmationStatus.requiredMemberIds.every((memberId) => confirmed.has(memberId))) {
        throw new TreasuryError(
          409,
          "deployment_confirmations_missing",
          "every proven council member must confirm the browser RPC attestation before registration",
        );
      }
    }

    const safe = getAddress(input.safeAddress);
    const roles = getAddress(input.rolesAddress);
    const delay = getAddress(input.delayAddress);
    await this.baseVerifierFactory(environment).verify({
      owners: members.map((member) => getAddress(member.evmAddress as string)),
      threshold: expectedThreshold,
      safeAddress: safe,
      rolesAddress: roles,
      delayAddress: delay,
      govAddress: nearDeployment.expectedGov,
      multiSendAddress: canonicalMultiSendCallOnlyAddress(environment.baseChainId),
      delayCooldownSeconds: environment.delayCooldownSeconds,
      delayExpirationSeconds: environment.delayExpirationSeconds,
    });

    return {
      environment,
      status: "active",
      safe,
      roles,
      delay,
      gov: nearDeployment.expectedGov,
      vaultWasmSha256: nearDeployment.vaultWasmSha256,
      relayWasmSha256: nearDeployment.relayWasmSha256,
      warnings,
    };
  }

  private async nearDeploymentConfirmationStatus(
    organizationId: string,
    environment: string,
    digest: string,
  ): Promise<NearDeploymentConfirmationStatus> {
    const [members, confirmations] = await Promise.all([
      this.prisma.member.findMany({
        where: { organizationId, walletProofVerifiedAt: { not: null } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.treasuryDeploymentConfirmation.findMany({
        where: { organizationId, environment, digest },
        select: { memberId: true },
      }),
    ]);
    return {
      digest,
      confirmedMemberIds: confirmations.map((confirmation) => confirmation.memberId),
      requiredMemberIds: members.map((member) => member.id),
    };
  }

  private async verifyNearDeployment(input: NearDeploymentAttestationInput): Promise<{
    digest: string;
    expectedGov: Address;
    vaultWasmSha256: string;
    relayWasmSha256: string;
  }> {
    const environment = this.environment(input.environment);
    const vaultArtifact = await loadArtifact(this.config.artifactsDir, "vault.wasm");
    const relayArtifact = await loadArtifact(this.config.artifactsDir, "governance_relay.wasm");
    await this.verifyNearAccount(input.vaultAccountId, vaultArtifact.sha256);
    await this.verifyNearAccount(input.relayAccountId, relayArtifact.sha256);

    const vaultOwner = await this.near.viewFunction<string>(input.vaultAccountId, "owner_id");
    const relayOwner = await this.near.viewFunction<string>(input.relayAccountId, "owner_id");
    if (vaultOwner !== input.daoAccountId) {
      throw new TreasuryError(422, "vault_owner_mismatch", "Vault owner is not the DAO");
    }
    if (relayOwner !== input.daoAccountId) {
      throw new TreasuryError(422, "relay_owner_mismatch", "relay owner is not the DAO");
    }

    const expectedGuardKey = Buffer.from(await this.signer.publicKey()).toString("base64");
    const vaultParameters: Array<[string, unknown, unknown, string]> = [
      ["mpc_contract_id", await this.near.viewFunction<string>(input.vaultAccountId, "mpc_contract_id"), this.config.mpcContractId, "vault_mpc_mismatch"],
      ["evm_chain_id", await this.near.viewFunction<number>(input.vaultAccountId, "evm_chain_id"), environment.baseChainId, "vault_chain_mismatch"],
      ["guard_public_key", await this.near.viewFunction<string>(input.vaultAccountId, "guard_public_key"), expectedGuardKey, "vault_guard_key_mismatch"],
      ["token_id", await this.near.viewFunction<string>(input.vaultAccountId, "token_id"), this.config.budgetTokenAccountId, "vault_token_mismatch"],
      ["reservation_ttl_blocks", await this.near.viewFunction<number>(input.vaultAccountId, "reservation_ttl_blocks"), this.config.vaultTtlBlocks, "vault_ttl_mismatch"],
    ];
    for (const [name, actual, expected, code] of vaultParameters) {
      if (actual !== expected) {
        throw new TreasuryError(422, code, `Vault ${name} is ${String(actual)}, expected ${String(expected)}`);
      }
    }

    const expectedMultiSend = canonicalMultiSendCallOnlyAddress(environment.baseChainId);
    const expectedMultiSendBase64 = Buffer.from(expectedMultiSend.slice(2), "hex").toString("base64");
    const expectedClientId = input.daoAccountId.split(".")[0] ?? "";
    const relayParameters: Array<[string, unknown, unknown, string]> = [
      ["client_id", await this.near.viewFunction<string>(input.relayAccountId, "client_id"), expectedClientId, "relay_client_mismatch"],
      ["mpc_contract_id", await this.near.viewFunction<string>(input.relayAccountId, "mpc_contract_id"), this.config.mpcContractId, "relay_mpc_mismatch"],
      ["mpc_path", await this.near.viewFunction<string>(input.relayAccountId, "mpc_path"), this.config.mpcPath, "relay_mpc_path_mismatch"],
      ["evm_chain_id", await this.near.viewFunction<number>(input.relayAccountId, "evm_chain_id"), environment.baseChainId, "relay_chain_mismatch"],
      ["multisend_address", await this.near.viewFunction<string>(input.relayAccountId, "multisend_address"), expectedMultiSendBase64, "relay_multisend_mismatch"],
      ["guard_public_key", await this.near.viewFunction<string>(input.relayAccountId, "guard_public_key"), expectedGuardKey, "relay_guard_key_mismatch"],
    ];
    for (const [name, actual, expected, code] of relayParameters) {
      if (actual !== expected) {
        throw new TreasuryError(422, code, `relay ${name} is ${String(actual)}, expected ${String(expected)}`);
      }
    }

    const expectedGov = getAddress(input.govAddress);
    const expectedDelay = getAddress(input.delayAddress);
    const relayDelay = await this.near.viewFunction<string>(input.relayAccountId, "delay_address");
    if (Buffer.from(relayDelay, "base64").toString("hex") !== expectedDelay.slice(2).toLowerCase()) {
      throw new TreasuryError(422, "relay_delay_mismatch", "relay delay_address is not the registered Delay");
    }

    const digest = createHash("sha256").update(JSON.stringify({
      version: 2,
      environment: input.environment,
      daoAccountId: input.daoAccountId,
      vaultAccountId: input.vaultAccountId,
      vaultWasmSha256: vaultArtifact.sha256,
      relayAccountId: input.relayAccountId,
      relayWasmSha256: relayArtifact.sha256,
      clientId: expectedClientId,
      mpcContractId: this.config.mpcContractId,
      mpcPath: this.config.mpcPath,
      baseChainId: environment.baseChainId,
      tokenId: this.config.budgetTokenAccountId,
      guardPublicKey: expectedGuardKey,
      reservationTtlBlocks: this.config.vaultTtlBlocks,
      govAddress: expectedGov,
      delayAddress: expectedDelay,
      multiSendCallOnlyAddress: expectedMultiSend,
    })).digest("hex");
    return {
      digest,
      expectedGov,
      vaultWasmSha256: vaultArtifact.sha256,
      relayWasmSha256: relayArtifact.sha256,
    };
  }

  private validateDaoPolicy(policy: SputnikPolicy, council: string[], threshold: bigint): void {
    const roles = Array.isArray(policy.roles) ? policy.roles : [];
    const councilRoles = roles.filter((role) => role.name === "council");
    if (councilRoles.length === 0) {
      throw new TreasuryError(422, "dao_council_role_missing", "DAO has no council role");
    }
    if (councilRoles.length !== 1) {
      throw new TreasuryError(422, "dao_council_role_count", "DAO must have exactly one council role");
    }
    const councilRole = councilRoles[0]!;
    const group = isGroupKind(councilRole.kind) ? councilRole.kind.Group : null;
    if (!group) throw new TreasuryError(422, "dao_council_role_missing", "DAO has no council Group role");
    const actual = [...group].sort();
    const expected = [...council].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new TreasuryError(422, "dao_council_mismatch", "DAO council members do not match the organization");
    }
    assertRoleWeight(policy.default_vote_policy, "dao_weight_kind", "default_vote_policy");
    const policyThreshold = requiredVotes(policy.default_vote_policy?.threshold, council.length);
    if (policyThreshold === null || policyThreshold !== threshold) {
      throw new TreasuryError(422, "dao_threshold_mismatch", "DAO vote threshold is incorrect");
    }

    for (const role of roles) {
      const permissions = Array.isArray(role.permissions) ? role.permissions : [];
      const everyone = role.kind === "Everyone" || role.name === "Everyone";
      if (everyone && permissions.some((permission) => permission.includes("AddProposal"))) {
        throw new TreasuryError(422, "dao_everyone_add_proposal", "DAO grants AddProposal to Everyone");
      }
      if (role.name !== "council") {
        const voting = permissions.some((permission) => {
          const action = permissionAction(permission);
          return action === "*" || action === "AddProposal" || action.startsWith("Vote");
        });
        if (voting) {
          throw new TreasuryError(
            422,
            "dao_extra_voting_role",
            `role ${role.name ?? "<unnamed>"} carries a voting or AddProposal permission`,
          );
        }
      }
    }

    const councilVotePolicy = councilRole.vote_policy ?? {};
    for (const [kind, votePolicy] of Object.entries(councilVotePolicy)) {
      assertRoleWeight(votePolicy, "dao_vote_policy_weight", `council.vote_policy.${kind}`);
      const required = requiredVotes(votePolicy.threshold, council.length);
      if (required === null || required < threshold) {
        throw new TreasuryError(
          422,
          "dao_vote_policy_threshold",
          `council.vote_policy.${kind} threshold is below the expected threshold`,
        );
      }
    }
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
