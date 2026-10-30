import { serve } from "@hono/node-server";
import { prisma } from "@mandateos/db";
import { AgentProvisioningService } from "./agent-provisioning.js";
import { BaseGasEstimator } from "./base-gas.js";
import { Guard } from "./guard.js";
import { createApp } from "./app.js";
import { PrismaPairingStore } from "./pairings.js";
import { createAuth } from "./auth.js";
import { hasFullAccessKey } from "./near-auth.js";
import { BetterAuthGateway } from "./auth-gateway.js";
import { loadEnv } from "./env.js";
import { EnvKmsSigner } from "./kms.js";
import { NearClient } from "./near.js";
import { RegistryService } from "./registry-db.js";
import { PaymentService } from "./payments.js";
import { OmniRolesService } from "./omniroles.js";
import { chequeChain, finalTransaction, NearChequeRelayer, storageRegistered } from "./market/near-market.js";
import { MarketService } from "./market/service.js";
import { ZkPassportVerifier } from "./recovery/passport.js";
import { RecoveryService } from "./recovery/service.js";

const env = loadEnv();
const visaSigner = new EnvKmsSigner(
  Uint8Array.from(Buffer.from(env.GUARD_VISA_ED25519_PRIVATE_KEY_BASE64, "base64")),
);
const statusSigner = new EnvKmsSigner(
  Uint8Array.from(Buffer.from(env.GUARD_STATUS_ED25519_PRIVATE_KEY_BASE64, "base64")),
);
const guard = new Guard(visaSigner, statusSigner);
const near = new NearClient(env);
const gasEstimator = BaseGasEstimator.fromRpc(env.BASE_SEPOLIA_RPC_URL, {
  gasLimit: BigInt(env.BASE_TX_GAS_LIMIT_CAP),
  maxFeePerGas: BigInt(env.BASE_TX_MAX_FEE_PER_GAS_CAP_WEI),
  maxPriorityFeePerGas: BigInt(env.BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI),
});
const auth = new BetterAuthGateway(createAuth(env, prisma, {
  recipient: new URL(env.CONSOLE_ORIGIN).host,
  isFullAccessKey: async (accountId, publicKey) => {
    try {
      return hasFullAccessKey((await near.getAccessKeys(accountId)).keys, publicKey);
    } catch {
      return false;
    }
  },
  // Only a definite "unknown account" counts as missing: an RPC failure keeps the generic message.
  accountExists: async (accountId) => near.getAccount(accountId).then(
    () => true,
    (error: unknown) => !/does not exist|UNKNOWN_ACCOUNT/i.test(error instanceof Error ? error.message : String(error)),
  ),
}), prisma);
const agentProvisioning = new AgentProvisioningService(
  prisma,
  near,
  env.NEAR_ACCOUNT_PARENT,
  env.NEAR_SPONSOR_DAILY_WALLET_LIMIT,
  env.NEAR_AGENT_GAS_RESERVE_YOCTO,
);
const registryService = new RegistryService(prisma);
const payments = new PaymentService(prisma, near, guard, registryService, gasEstimator);
const omniroles = new OmniRolesService(prisma, near, visaSigner, statusSigner, {
  nearNetwork: env.NEAR_NETWORK_ID,
  daoFactoryId: env.DAO_FACTORY_ID,
  nomosId: env.NOMOS_ID,
  solanaRpcUrl: env.SOLANA_RPC_URL,
  txIndexerUrl: env.NEAR_TX_INDEXER_URL ?? (env.NEAR_NETWORK_ID === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com"),
  mpcContractId: env.MPC_CONTRACT_ID,
  artifactsDir: env.CONTRACT_ARTIFACTS_DIR,
  accountParent: env.NEAR_ACCOUNT_PARENT,
  daoCreateDepositYocto: env.DAO_CREATE_DEPOSIT_YOCTO,
  sharesDepositYocto: env.OMNIROLES_SHARES_DEPOSIT_YOCTO,
  sharesEpochSeconds: env.OMNIROLES_SHARES_EPOCH_SECONDS ?? (env.NEAR_NETWORK_ID === "testnet" ? 3600 : 7 * 24 * 3600),
  sharesRevenueToken: env.OMNIROLES_SHARES_REVENUE_TOKEN || null,
  omniBridgeApi: env.OMNI_BRIDGE_API_URL,
  registryId: env.OMNIROLES_REGISTRY_ID ?? (env.NEAR_NETWORK_ID === "testnet" ? "registry.mandateos.testnet" : undefined),
  baseRpcUrl: env.BASE_SEPOLIA_RPC_URL,
  extraRpcUrls: { 11155111: env.ETHEREUM_SEPOLIA_RPC_URL },
  ruleDelayNs: env.OMNIROLES_RULE_DELAY_SECONDS * 1_000_000_000,
  ruleExpirationNs: (env.OMNIROLES_RULE_DELAY_SECONDS + 7 * 86_400) * 1_000_000_000,
  operationTtlNs: 600_000_000_000,
  proposalPeriodNs: "604800000000000",
  proposalBondYocto: env.OMNIROLES_PROPOSAL_BOND_YOCTO,
});
// Rule changes activate by themselves once their veto window has passed.
setInterval(() => void omniroles.activateAllReadyRules(), 30_000).unref();

// Euthyna Market: only with its own relayer account.
const market = env.MARKET_RELAYER_ACCOUNT_ID && env.MARKET_RELAYER_PRIVATE_KEY && env.MARKET_WEBHOOK_SECRET
  ? new MarketService(
    prisma,
    chequeChain((method, params) => near.proxyRpc(method, params)),
    new NearChequeRelayer(env.MARKET_RELAYER_ACCOUNT_ID, env.MARKET_RELAYER_PRIVATE_KEY, env.NEAR_NETWORK_ID, env.NEAR_RPC_URL),
    {
      network: `near:${env.NEAR_NETWORK_ID}`,
      webhookSecret: env.MARKET_WEBHOOK_SECRET,
      dailySettlements: env.MARKET_DAILY_SETTLEMENTS,
      dailyPerBuyer: env.MARKET_DAILY_PER_BUYER,
      relayerLowYocto: BigInt(env.MARKET_RELAYER_LOW_YOCTO),
      settlementMarginSeconds: env.MARKET_SETTLEMENT_MARGIN_SECONDS,
    },
    undefined,
    undefined,
    (token, accountId) => storageRegistered((method, params) => near.proxyRpc(method, params), token, accountId),
    finalTransaction((method, params) => near.proxyRpc(method, params)),
  )
  : undefined;
if (market) setInterval(() => void market.expire().catch((error: unknown) => console.warn(`market expiry: ${String(error)}`)), 60_000).unref();

// Founder seat recovery: ZKPassport proofs, verified here; the members' vote changes the seat.
const recovery = new RecoveryService(prisma, new ZkPassportVerifier({
  domain: env.ZKPASSPORT_DOMAIN ?? new URL(env.CONSOLE_ORIGIN).hostname,
  devMode: env.ZKPASSPORT_DEV_MODE ? env.ZKPASSPORT_DEV_MODE === "1" : env.NEAR_NETWORK_ID === "testnet",
  sepoliaRpcUrl: env.ETHEREUM_SEPOLIA_RPC_URL,
}), {
  councilOf: (organizationId) => omniroles.councilOf(organizationId),
  organizationOfDao: (daoAccountId) => omniroles.organizationOfDao(daoAccountId),
  membersProposals: (organizationId, members) => omniroles.membersProposals(organizationId, members),
}, env.RECOVERY_DELAY_SECONDS * 1000);

const app = createApp({
  near,
  auth,
  treasuries: omniroles,
  agentProvisioning,
  registry: registryService,
  payments,
  consoleOrigin: env.CONSOLE_ORIGIN,
  nearParentAccount: env.NEAR_ACCOUNT_PARENT,
  pairings: new PrismaPairingStore(prisma),
  omniroles,
  market,
  publicBaseUrl: env.PUBLIC_API_URL ?? env.BETTER_AUTH_URL,
  marketTrustProxy: env.MARKET_TRUST_PROXY,
  recovery,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`MandateOS API listening on http://127.0.0.1:${info.port}`);
});
