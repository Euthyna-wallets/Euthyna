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
  DAO_FACTORY_ID: z.string().min(1).default("factory-v2.mandateos.testnet"),
  DAO_CREATE_DEPOSIT_YOCTO: z.string().regex(/^\d+$/).default("250000000000000000000000"),
  DAO_GLOBAL_CODE_HASH: z.string().min(32).default("Ea8tHXFSQVszVwGASyzAfLq65DjcRDhkfab4FcPaRpgD"),
  DAO_FACTORY_DEPOSIT_YOCTO: z.string().regex(/^\d+$/).default("2000000000000000000000000"),
  MPC_CONTRACT_ID: z.string().min(1).default("v1.signer-prod.testnet"),
  BUDGET_TOKEN_ACCOUNT_ID: z.string().min(1),
  CONTRACT_ARTIFACTS_DIR: z.string().default("contracts/res"),
});

type ParsedEnv = z.infer<typeof schema>;

export type Env = Omit<ParsedEnv, "PASSKEY_RP_ID" | "NEAR_ACCOUNT_PARENT"> & {
  PASSKEY_RP_ID: string;
  NEAR_ACCOUNT_PARENT: string;
};

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.parse(input);
  return {
    ...parsed,
    PASSKEY_RP_ID: parsed.PASSKEY_RP_ID ?? new URL(parsed.CONSOLE_ORIGIN).hostname,
    NEAR_ACCOUNT_PARENT: parsed.NEAR_ACCOUNT_PARENT ?? parsed.NEAR_RELAYER_ACCOUNT_ID,
  };
}
