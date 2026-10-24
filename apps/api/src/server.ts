import { serve } from "@hono/node-server";
import { prisma } from "@mandateos/db";
import { AgentProvisioningService } from "./agent-provisioning.js";
import { Guard } from "./guard.js";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
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
import { WalletProofService } from "./wallet-proof.js";

const env = loadEnv();
const guardKey = Uint8Array.from(Buffer.from(env.GUARD_ED25519_PRIVATE_KEY_BASE64, "base64"));
const signer = new EnvKmsSigner(guardKey);
const guard = new Guard(signer);
const near = new NearClient(env);
const relayer = createBaseRelayer(env, near, guard);
const auth = new BetterAuthGateway(createAuth(env, prisma), prisma);
const walletProof = new WalletProofService(
  prisma,
  near,
  env.NEAR_ACCOUNT_PARENT,
  84532,
  env.UAT_DEMO_WALLETS_ENABLED,
);
const agentProvisioning = new AgentProvisioningService(
  prisma,
  near,
  env.NEAR_ACCOUNT_PARENT,
  env.NEAR_SPONSOR_DAILY_WALLET_LIMIT,
  env.NEAR_AGENT_GAS_RESERVE_YOCTO,
);
const treasury = new TreasuryService(prisma, near, signer, {
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
});
const mandates = new MandateService(
  prisma,
  near,
  env.BUDGET_TOKEN_ACCOUNT_ID,
  env.BASE_SEPOLIA_RPC_URL,
);
const governance = new GovernanceService(prisma, near, env.BASE_SEPOLIA_RPC_URL);
const registryService = new RegistryService(prisma);
const payments = new PaymentService(prisma, near, guard, registryService);
const consoleData = new ConsoleDataService(
  prisma,
  near,
  env.BASE_SEPOLIA_RPC_URL,
  env.NEAR_AGENT_GAS_LOW_YOCTO,
);
const app = createApp({
  near,
  guard,
  relayer,
  auth,
  walletProof,
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
  registrationRateLimitEnabled: !env.UAT_DEMO_WALLETS_ENABLED,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`MandateOS API listening on http://127.0.0.1:${info.port}`);
});
