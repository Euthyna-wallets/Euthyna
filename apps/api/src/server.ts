import { serve } from "@hono/node-server";
import { prisma } from "@mandateos/db";
import { Guard } from "./guard.js";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { BetterAuthGateway } from "./auth-gateway.js";
import { loadEnv } from "./env.js";
import { EnvKmsSigner } from "./kms.js";
import { NearClient } from "./near.js";
import { loadRegistry } from "./registry.js";
import { createBaseRelayer } from "./relayer.js";
import { TreasuryService } from "./treasury.js";

const env = loadEnv();
const registry = await loadRegistry(env.VENDOR_REGISTRY_PATH);
const guardKey = Uint8Array.from(Buffer.from(env.GUARD_ED25519_PRIVATE_KEY_BASE64, "base64"));
const signer = new EnvKmsSigner(guardKey);
const guard = new Guard(registry, signer);
const near = new NearClient(env);
const relayer = createBaseRelayer(env, near, guard);
const auth = new BetterAuthGateway(createAuth(env, prisma), prisma);
const treasury = new TreasuryService(prisma, near, signer, {
  nearNetwork: env.NEAR_NETWORK_ID,
  daoFactoryId: env.DAO_FACTORY_ID,
  mpcContractId: env.MPC_CONTRACT_ID,
  mpcPath: "governance/base-sepolia",
  baseRpcUrl: env.BASE_SEPOLIA_RPC_URL,
  budgetTokenAccountId: env.BUDGET_TOKEN_ACCOUNT_ID,
  artifactsDir: env.CONTRACT_ARTIFACTS_DIR,
  baseChainId: 84532,
  vaultTtlBlocks: 50,
  vaultDepositYocto: "10000000000000000000000000",
  relayDepositYocto: "10000000000000000000000000",
  daoCreateDepositYocto: "10000000000000000000000000",
});
const app = createApp({ near, guard, relayer, auth, treasury, consoleOrigin: env.CONSOLE_ORIGIN });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`MandateOS API listening on http://127.0.0.1:${info.port}`);
});
