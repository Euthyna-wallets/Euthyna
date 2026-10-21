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
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  CONSOLE_ORIGIN: z.string().url().default("http://localhost:5173"),
  PASSKEY_RP_ID: z.string().min(1).optional(),
  DAO_FACTORY_ID: z.string().min(1).default("sputnikv2.testnet"),
  MPC_CONTRACT_ID: z.string().min(1).default("v1.signer-prod.testnet"),
  BUDGET_TOKEN_ACCOUNT_ID: z.string().min(1),
  CONTRACT_ARTIFACTS_DIR: z.string().default("contracts/res"),
  NODE_ENV: z.string().optional(),
  AUTH_E2E_PASSWORD: z.enum(["0", "1"]).default("0"),
});

type ParsedEnv = z.infer<typeof schema>;

export type Env = Omit<ParsedEnv, "PASSKEY_RP_ID"> & { PASSKEY_RP_ID: string };

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.parse(input);
  if (parsed.AUTH_E2E_PASSWORD === "1" && parsed.NODE_ENV !== "test") {
    throw new Error("AUTH_E2E_PASSWORD=1 is only allowed with NODE_ENV=test");
  }
  return {
    ...parsed,
    PASSKEY_RP_ID: parsed.PASSKEY_RP_ID ?? new URL(parsed.CONSOLE_ORIGIN).hostname,
  };
}
