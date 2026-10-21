import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NEAR_NETWORK_ID: z.string().default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.near.org"),
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  VENDOR_REGISTRY_PATH: z.string().default("config/clients/acme/vendors.json"),
  GUARD_ED25519_PRIVATE_KEY_BASE64: z.string().min(1),
  NEAR_RELAYER_ACCOUNT_ID: z.string().min(1),
  NEAR_RELAYER_PRIVATE_KEY: z.string().min(1),
  AGENT_API_TOKEN: z.string().min(24),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(input);
}
