import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NEAR_NETWORK_ID: z.string().default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.near.org"),
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  BASE_MAINNET_RPC_URL: z.string().url().optional(),
  VENDOR_REGISTRY_PATH: z.string().default("config/clients/acme/vendors.json"),
  GUARD_ED25519_PRIVATE_KEY_BASE64: z.string().min(1),
  NEAR_RELAYER_ACCOUNT_ID: z.string().min(1),
  NEAR_RELAYER_PRIVATE_KEY: z.string().min(1),
  NEAR_ACCOUNT_PARENT: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  CONSOLE_ORIGIN: z.string().url().default("http://localhost:5173"),
  PASSKEY_RP_ID: z.string().min(1).optional(),
  NEAR_SPONSOR_DAILY_WALLET_LIMIT: z.coerce.number().int().min(0).max(100).default(5),
  NEAR_SPONSOR_WALLET_AMOUNT_YOCTO: z.string().regex(/^\d+$/).default("500000000000000000000000"),
  UAT_DEMO_WALLETS_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  NEAR_AGENT_GAS_RESERVE_YOCTO: z.string().regex(/^\d+$/).default("300000000000000000000000"),
  NEAR_AGENT_GAS_LOW_YOCTO: z.string().regex(/^\d+$/).default("50000000000000000000000"),
  DAO_FACTORY_ID: z.string().min(1).default("factory-v2.mandateos.testnet"),
  DAO_CREATE_DEPOSIT_YOCTO: z.string().regex(/^\d+$/).default("250000000000000000000000"),
  DAO_GLOBAL_CODE_HASH: z.string().min(32).default("Ea8tHXFSQVszVwGASyzAfLq65DjcRDhkfab4FcPaRpgD"),
  DAO_FACTORY_DEPOSIT_YOCTO: z.string().regex(/^\d+$/).default("2000000000000000000000000"),
  MPC_CONTRACT_ID: z.string().min(1).default("v1.signer-prod.testnet"),
  BUDGET_TOKEN_ACCOUNT_ID: z.string().min(1),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
  WORKER_CONFIRMATIONS: z.coerce.number().int().positive().max(100).default(5),
  WORKER_LEASE_MS: z.coerce.number().int().min(1_000).default(20_000),
  WORKER_STUCK_BLOCKS: z.coerce.number().int().positive().default(120),
  WORKER_BROADCAST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  WORKER_RETRY_BASE_MS: z.coerce.number().int().min(100).default(1_000),
  WORKER_RETRY_MAX_MS: z.coerce.number().int().min(1_000).default(60_000),
  BASE_GAS_WALLET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  BASE_GAS_WALLET_MIN_BALANCE_WEI: z.string().regex(/^\d+$/).default("5000000000000000"),
  BASE_TX_GAS_LIMIT_CAP: z.string().regex(/^[1-9]\d*$/).default("300000"),
  BASE_TX_MAX_FEE_PER_GAS_CAP_WEI: z.string().regex(/^[1-9]\d*$/).default("100000000000"),
  BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI: z.string().regex(/^[1-9]\d*$/).default("10000000000"),
  GOVERNANCE_MAX_FEE_FLOOR_WEI: z.string().regex(/^[1-9]\d*$/).default("100000000"),
  CONTRACT_ARTIFACTS_DIR: z.string().default("contracts/res"),
});

type ParsedEnv = z.infer<typeof schema>;

export type Env = Omit<ParsedEnv, "PASSKEY_RP_ID" | "NEAR_ACCOUNT_PARENT"> & {
  PASSKEY_RP_ID: string;
  NEAR_ACCOUNT_PARENT: string;
};

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.parse(input);
  if (BigInt(parsed.BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI) > BigInt(parsed.BASE_TX_MAX_FEE_PER_GAS_CAP_WEI)) {
    throw new Error("BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI must not exceed BASE_TX_MAX_FEE_PER_GAS_CAP_WEI");
  }
  if (BigInt(parsed.GOVERNANCE_MAX_FEE_FLOOR_WEI) > BigInt(parsed.BASE_TX_MAX_FEE_PER_GAS_CAP_WEI)) {
    throw new Error("GOVERNANCE_MAX_FEE_FLOOR_WEI must not exceed BASE_TX_MAX_FEE_PER_GAS_CAP_WEI");
  }
  return {
    ...parsed,
    PASSKEY_RP_ID: parsed.PASSKEY_RP_ID ?? new URL(parsed.CONSOLE_ORIGIN).hostname,
    NEAR_ACCOUNT_PARENT: parsed.NEAR_ACCOUNT_PARENT ?? parsed.NEAR_RELAYER_ACCOUNT_ID,
  };
}
