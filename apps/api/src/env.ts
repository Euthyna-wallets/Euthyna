import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NEAR_NETWORK_ID: z.string().default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.near.org"),
  /** NEAR RPC calls at once, and the least time between two starts (a public RPC rate-limits). */
  NEAR_RPC_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),
  NEAR_RPC_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(5_000).default(150),
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  BASE_MAINNET_RPC_URL: z.string().url().optional(),
  VENDOR_REGISTRY_PATH: z.string().default("config/clients/acme/vendors.json"),
  GUARD_VISA_ED25519_PRIVATE_KEY_BASE64: z.string().min(1),
  GUARD_STATUS_ED25519_PRIVATE_KEY_BASE64: z.string().min(1),
  NEAR_RELAYER_ACCOUNT_ID: z.string().min(1),
  NEAR_RELAYER_PRIVATE_KEY: z.string().min(1),
  // Empty means "the relayer": only an account can create its own sub-accounts.
  NEAR_ACCOUNT_PARENT: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  CONSOLE_ORIGIN: z.string().url().default("http://localhost:5173"),
  NEAR_SPONSOR_DAILY_WALLET_LIMIT: z.coerce.number().int().min(0).max(100).default(5),
  NEAR_SPONSOR_WALLET_AMOUNT_YOCTO: z.string().regex(/^\d+$/).default("500000000000000000000000"),
  UAT_DEMO_WALLETS_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  NEAR_AGENT_GAS_RESERVE_YOCTO: z.string().regex(/^\d+$/).default("300000000000000000000000"),
  NEAR_AGENT_GAS_LOW_YOCTO: z.string().regex(/^\d+$/).default("50000000000000000000000"),
  /** Sputnik DAO factory (official): sputnikv2.testnet on testnet. */
  DAO_FACTORY_ID: z.string().min(1).default("sputnikv2.testnet"),
  /** Nomos factory: creates company vaults from published versions. */
  NOMOS_ID: z.string().min(1).default("nomos.euthyna.testnet"),
  /** Solana RPC for the company's Solana wallet (devnet on testnet). */
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  /** NEAR transaction index used to read the vault's own logs (FastNEAR tx API). Empty disables it. */
  NEAR_TX_INDEXER_URL: z.string().optional(),
  DAO_CREATE_DEPOSIT_YOCTO: z.string().regex(/^\d+$/).default("6000000000000000000000000"),
  DAO_GLOBAL_CODE_HASH: z.string().min(32).default("Ea8tHXFSQVszVwGASyzAfLq65DjcRDhkfab4FcPaRpgD"),
  DAO_FACTORY_DEPOSIT_YOCTO: z.string().regex(/^\d+$/).default("2000000000000000000000000"),
  MPC_CONTRACT_ID: z.string().min(1).default("v1.signer-prod.testnet"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
  WORKER_CONFIRMATIONS: z.coerce.number().int().positive().max(100).default(5),
  WORKER_LEASE_MS: z.coerce.number().int().min(1_000).default(20_000),
  WORKER_STUCK_BLOCKS: z.coerce.number().int().positive().default(120),
  WORKER_BROADCAST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  WORKER_RETRY_BASE_MS: z.coerce.number().int().min(100).default(1_000),
  WORKER_RETRY_MAX_MS: z.coerce.number().int().min(1_000).default(60_000),
  BASE_TX_GAS_LIMIT_CAP: z.string().regex(/^[1-9]\d*$/).default("300000"),
  BASE_TX_MAX_FEE_PER_GAS_CAP_WEI: z.string().regex(/^[1-9]\d*$/).default("100000000000"),
  BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI: z.string().regex(/^[1-9]\d*$/).default("10000000000"),
  CONTRACT_ARTIFACTS_DIR: z.string().default("contracts/res"),
  ETHEREUM_SEPOLIA_RPC_URL: z.string().url().default("https://ethereum-sepolia-rpc.publicnode.com"),
  OMNIROLES_RULE_DELAY_SECONDS: z.coerce.number().int().min(60).default(300),
  OMNIROLES_SHARES_DEPOSIT_YOCTO: z.string().regex(/^\d+$/).default("2900000000000000000000000"),
  /** Revenue epoch of new shares contracts. Default: 1 hour on testnet, 7 days elsewhere. */
  OMNIROLES_SHARES_EPOCH_SECONDS: z.coerce.number().int().positive().optional(),
  /** NEP-141 shared as revenue next to NEAR. Default: Base Sepolia ETH bridged by Omni Bridge. */
  OMNIROLES_SHARES_REVENUE_TOKEN: z.string().default("base.omnidep.testnet"),
  /** Public directory of AI companies (contracts/registry); empty disables listing. */
  OMNIROLES_REGISTRY_ID: z.string().optional(),
  OMNI_BRIDGE_API_URL: z.string().url().default("https://testnet.api.bridge.nearone.org"),
  OMNIROLES_PROPOSAL_BOND_YOCTO: z.string().regex(/^\d+$/).default("100000000000000000000000"),
  /** Euthyna Market. Enabled when the market relayer is set: a dedicated account, never the company relayer. */
  MARKET_RELAYER_ACCOUNT_ID: z.string().optional(),
  MARKET_RELAYER_PRIVATE_KEY: z.string().optional(),
  /** Derives each listing's webhook signing key. */
  MARKET_WEBHOOK_SECRET: z.string().optional(),
  MARKET_DAILY_SETTLEMENTS: z.coerce.number().int().min(0).default(200),
  MARKET_DAILY_PER_BUYER: z.coerce.number().int().min(0).default(20),
  /** "1" when the API sits behind our own reverse proxy: rate limits then use its X-Forwarded-For hop. */
  MARKET_TRUST_PROXY: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  MARKET_RELAYER_LOW_YOCTO: z.string().regex(/^\d+$/).default("2000000000000000000000000"),
  MARKET_SETTLEMENT_MARGIN_SECONDS: z.coerce.number().int().min(60).default(600),
  /** Founder seat recovery: how long the lost account can cancel before the members vote (default 48 h). */
  RECOVERY_DELAY_SECONDS: z.coerce.number().int().min(60).default(172_800),
  /**
   * Testnet only: DKIM keys of test mail domains, as JSON {"<selector>._domainkey.<domain>": "v=DKIM1; k=rsa; p=…"}.
   * Lets tests sign their own emails. Ignored unless NEAR_NETWORK_ID is testnet.
   */
  RECOVERY_TEST_DKIM_KEYS: z.string().optional(),
  /** Public URL of this API, as buyers reach it (agent cards). */
  PUBLIC_API_URL: z.string().url().optional(),
});

type ParsedEnv = z.infer<typeof schema>;

export type Env = Omit<ParsedEnv, "NEAR_ACCOUNT_PARENT"> & {
  NEAR_ACCOUNT_PARENT: string;
};

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.parse(input);
  if (BigInt(parsed.BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI) > BigInt(parsed.BASE_TX_MAX_FEE_PER_GAS_CAP_WEI)) {
    throw new Error("BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI must not exceed BASE_TX_MAX_FEE_PER_GAS_CAP_WEI");
  }
  const parent = parsed.NEAR_ACCOUNT_PARENT ?? parsed.NEAR_RELAYER_ACCOUNT_ID;
  // Vaults and agents are created as <name>.<parent>; NEAR lets only <parent> itself create them.
  if (parent !== parsed.NEAR_RELAYER_ACCOUNT_ID) {
    throw new Error(
      `NEAR_ACCOUNT_PARENT (${parent}) must be the relayer account (${parsed.NEAR_RELAYER_ACCOUNT_ID}): ` +
      "only an account can create its own sub-accounts. Leave it empty to use the relayer.",
    );
  }
  if (parsed.MARKET_RELAYER_ACCOUNT_ID) {
    if (!parsed.MARKET_RELAYER_PRIVATE_KEY || !parsed.MARKET_WEBHOOK_SECRET || parsed.MARKET_WEBHOOK_SECRET.length < 32) {
      throw new Error("the market needs MARKET_RELAYER_PRIVATE_KEY and a MARKET_WEBHOOK_SECRET of at least 32 characters");
    }
    // Settlements spend the market relayer's NEAR: never the account that sponsors companies.
    if (parsed.MARKET_RELAYER_ACCOUNT_ID === parsed.NEAR_RELAYER_ACCOUNT_ID) throw new Error("MARKET_RELAYER_ACCOUNT_ID must be a dedicated account, not NEAR_RELAYER_ACCOUNT_ID");
  }
  return { ...parsed, NEAR_ACCOUNT_PARENT: parent };
}
