import { serve } from "@hono/node-server";
import { prisma } from "@mandateos/db";
import { AgentProvisioningService } from "./agent-provisioning.js";
import { BaseGasEstimator } from "./base-gas.js";
import { Guard } from "./guard.js";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { hasFullAccessKey } from "./near-auth.js";
import { BetterAuthGateway } from "./auth-gateway.js";
import { loadEnv } from "./env.js";
import { GovernanceService } from "./governance.js";
import { EnvKmsSigner } from "./kms.js";
import { NearClient } from "./near.js";
import { createBaseRelayer } from "./relayer.js";
import { TreasuryService } from "./treasury.js";
import { MandateService } from "./mandates.js";
import { RegistryService } from "./registry-db.js";
import { PaymentService } from "./payments.js";
import { ConsoleDataService } from "./console-data.js";
import { OmniRolesService } from "./omniroles.js";

const env = loadEnv();
const visaSigner = new EnvKmsSigner(
  Uint8Array.from(Buffer.from(env.GUARD_VISA_ED25519_PRIVATE_KEY_BASE64, "base64")),
);
const statusSigner = new EnvKmsSigner(
  Uint8Array.from(Buffer.from(env.GUARD_STATUS_ED25519_PRIVATE_KEY_BASE64, "base64")),
);
const guard = new Guard(visaSigner, statusSigner);
const near = new NearClient(env);
const relayer = createBaseRelayer(env, near, guard);
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
}), prisma);
const agentProvisioning = new AgentProvisioningService(
  prisma,
  near,
  env.NEAR_ACCOUNT_PARENT,
  env.NEAR_SPONSOR_DAILY_WALLET_LIMIT,
  env.NEAR_AGENT_GAS_RESERVE_YOCTO,
);
const treasury = new TreasuryService(prisma, near, visaSigner, {
  nearNetwork: env.NEAR_NETWORK_ID,
  daoFactoryId: env.DAO_FACTORY_ID,
  mpcContractId: env.MPC_CONTRACT_ID,
  mpcPath: "governance/base-sepolia",
  budgetTokenAccountId: env.BUDGET_TOKEN_ACCOUNT_ID,
  artifactsDir: env.CONTRACT_ARTIFACTS_DIR,
  accountParent: env.NEAR_ACCOUNT_PARENT,
  environments: {
    uat: {
      baseChainId: 84532,
      baseRpcUrl: env.BASE_SEPOLIA_RPC_URL,
      delayCooldownSeconds: 300n,
      delayExpirationSeconds: 604_800n,
    },
    ...(env.BASE_MAINNET_RPC_URL
      ? {
          production: {
            baseChainId: 8453,
            baseRpcUrl: env.BASE_MAINNET_RPC_URL,
            delayCooldownSeconds: 86_400n,
            delayExpirationSeconds: 604_800n,
          },
        }
      : {}),
  },
  vaultTtlBlocks: 50,
  vaultDepositYocto: "5000000000000000000000000",
  relayDepositYocto: "3500000000000000000000000",
  daoCreateDepositYocto: env.DAO_CREATE_DEPOSIT_YOCTO,
  baseGasCaps: {
    gasLimit: env.BASE_TX_GAS_LIMIT_CAP,
    maxFeePerGas: env.BASE_TX_MAX_FEE_PER_GAS_CAP_WEI,
    maxPriorityFeePerGas: env.BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI,
  },
});
const mandates = new MandateService(
  prisma,
  near,
  env.BUDGET_TOKEN_ACCOUNT_ID,
  env.BASE_SEPOLIA_RPC_URL,
  gasEstimator,
  {
    gasLimit: BigInt(env.BASE_TX_GAS_LIMIT_CAP),
    maxFeePerGas: BigInt(env.BASE_TX_MAX_FEE_PER_GAS_CAP_WEI),
    maxPriorityFeePerGas: BigInt(env.BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI),
  },
  BigInt(env.GOVERNANCE_MAX_FEE_FLOOR_WEI),
);
const governance = new GovernanceService(prisma, near, {
  baseRpcUrl: env.BASE_SEPOLIA_RPC_URL,
  gasEstimator,
  governanceMaxFeeFloor: BigInt(env.GOVERNANCE_MAX_FEE_FLOOR_WEI),
});
const registryService = new RegistryService(prisma);
const payments = new PaymentService(prisma, near, guard, registryService, gasEstimator);
const consoleData = new ConsoleDataService(
  prisma,
  near,
  env.BASE_SEPOLIA_RPC_URL,
  env.NEAR_AGENT_GAS_LOW_YOCTO,
);
const omniroles = new OmniRolesService(prisma, near, visaSigner, statusSigner, {
  nearNetwork: env.NEAR_NETWORK_ID,
  daoFactoryId: env.DAO_FACTORY_ID,
  mpcContractId: env.MPC_CONTRACT_ID,
  artifactsDir: env.CONTRACT_ARTIFACTS_DIR,
  accountParent: env.NEAR_ACCOUNT_PARENT,
  daoCreateDepositYocto: env.DAO_CREATE_DEPOSIT_YOCTO,
  vaultDepositYocto: env.OMNIROLES_VAULT_DEPOSIT_YOCTO,
  baseRpcUrl: env.BASE_SEPOLIA_RPC_URL,
  ruleDelayNs: env.OMNIROLES_RULE_DELAY_SECONDS * 1_000_000_000,
  ruleExpirationNs: (env.OMNIROLES_RULE_DELAY_SECONDS + 7 * 86_400) * 1_000_000_000,
  operationTtlNs: 600_000_000_000,
  proposalPeriodNs: "604800000000000",
  proposalBondYocto: env.OMNIROLES_PROPOSAL_BOND_YOCTO,
});
// Rule changes activate by themselves once their veto window has passed.
setInterval(() => void omniroles.activateAllReadyRules(), 30_000).unref();

const app = createApp({
  near,
  guard,
  relayer,
  auth,
  treasury,
  agentProvisioning,
  governance,
  mandates,
  registry: registryService,
  payments,
  consoleData,
  consoleOrigin: env.CONSOLE_ORIGIN,
  nearParentAccount: env.NEAR_ACCOUNT_PARENT,
  nearSponsorDailyWalletLimit: env.NEAR_SPONSOR_DAILY_WALLET_LIMIT,
  nearSponsorWalletAmountYocto: env.NEAR_SPONSOR_WALLET_AMOUNT_YOCTO,
  omniroles,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`MandateOS API listening on http://127.0.0.1:${info.port}`);
});
