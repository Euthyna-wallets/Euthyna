import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
/**
 * Rob the Agent, « Hire him » (apps/api/src/rob/hire.ts): Ruggy's tx-check listing on the Market, delivered
 * by the API itself with the listing's delivery token, and the one test-token top-up per player.
 */
const robHireFields = {
  ROB_HIRE_HANDLE: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/).default("ruggy-tx-check"),
  /** The listing's delivery token (mdt_…, from scripts/rob-hire-setup.mjs or a console rotation); unset: no in-process delivery. */
  ROB_HIRE_DELIVERY_TOKEN: z.preprocess((value) => (value === "" ? undefined : value), z.string().regex(/^mdt_[A-Za-z0-9_-]{43}$/).optional()),
  /** Top-ups a UTC day, for everyone (each costs Ruggy a storage deposit and three transactions' gas). */
  ROB_HIRE_DAILY_TOPUPS: z.coerce.number().int().min(0).default(100),
  /** Top-ups per connection (salted address hash) over 24 hours. */
  ROB_HIRE_TOPUPS_PER_CLIENT: z.coerce.number().int().min(1).default(3),
  /** NEAR sent to create a player's implicit account. 1 yocto: an account this small needs no storage stake (NEP-448). */
  ROB_HIRE_ACCOUNT_YOCTO: z.string().regex(/^[1-9]\d*$/).default("1"),
  /** How often the API looks for Ruggy's tasks to deliver. */
  ROB_HIRE_POLL_MS: z.coerce.number().int().min(500).default(2_000),
};
const robHireSchema = z.object(robHireFields);
export type RobHireSettings = z.infer<typeof robHireSchema>;
/** Only the « Hire him » settings: the module reads them itself (the extras context carries no env). */
export function robHireSettings(input: NodeJS.ProcessEnv = process.env): RobHireSettings {
  return robHireSchema.parse(input);
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NEAR_NETWORK_ID: z.string().default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.near.org"),
  /** Used while NEAR_RPC_URL refuses for its quota or rate (a public endpoint): server only, like NEAR_RPC_URL. */
  NEAR_RPC_FALLBACK_URL: z.string().url().optional(),
  /**
   * More endpoints for the pool, comma separated, after NEAR_RPC_URL and before NEAR_RPC_FALLBACK_URL
   * (testnet, public: https://rpc.testnet.fastnear.com,https://near-testnet.drpc.org,https://rpc.testnet.near.org).
   * One that refuses for its rate or quota rests; the next one answers. Server only.
   */
  NEAR_RPC_URLS: z.string().optional(),
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
  /**
   * Where company DAOs are created: the official Sputnik factory, sputnikv2.testnet on testnet.
   * The Euthyna directory (euthyna-directory.testnet) lists DAOs from this factory with a vault from
   * euthyna-nomos.testnet; atlantis-registry.testnet keeps those with a vault from nomos.euthyna.testnet.
   * factory-v2.mandateos.testnet DAOs belong to the first directory (registry.mandateos.testnet) only.
   */
  DAO_FACTORY_ID: z.string().min(1).default("sputnikv2.testnet"),
  /** Nomos factory: creates company vaults from published versions. */
  NOMOS_ID: z.string().min(1).default("euthyna-nomos.testnet"),
  /** Solana RPC for the company's Solana wallet (devnet on testnet). */
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  /** NEAR transaction index used to read the vault's own logs (FastNEAR tx API). Empty disables it. */
  NEAR_TX_INDEXER_URL: z.string().optional(),
  /** NEAR the relayer gives each new DAO: sputnikv2.testnet deploys the full Sputnik code into it, so 6 (a factory-v2 DAO with global code needs 1). */
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
  /** Noah Business API key (server only): a euro IBAN per company, settling into its wallet. Unset: no bank account. */
  NOAH_API_KEY: z.string().min(1).optional(),
  /** https://api.sandbox.noah.com/v1 (default) or https://api.noah.com/v1. */
  NOAH_API_URL: z.string().url().default("https://api.sandbox.noah.com/v1"),
  /** The bank signer deployed on OutLayer (bank-signer/): its WASM URL and sha256, and the secrets it reads. Unset: no euro payouts. */
  BANK_SIGNER_URL: z.string().url().optional(),
  BANK_SIGNER_HASH: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** The enclave's X25519 box key (hex), from its `pubkey` output: beneficiaries are sealed to it. */
  BANK_SIGNER_BOX_KEY: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** The enclave's OutLayer project ("owner/name"); vaults that follow it take its versions after the veto window. */
  BANK_SIGNER_PROJECT: z.string().regex(/^[a-z0-9._-]+\/[A-Za-z0-9._-]+$/).optional(),
  BANK_SIGNER_SECRETS_OWNER: z.string().min(2).optional(),
  BANK_SIGNER_SECRETS_PROFILE: z.string().min(1).default("noah"),
  BANK_SIGNER_OUTLAYER_ID: z.string().min(2).default("outlayer.testnet"),
  /** Earlier directories, comma-separated: companies whose vault comes from an earlier Nomos list there. */
  OMNIROLES_PREVIOUS_REGISTRY_IDS: z.string().optional(),
  OMNI_BRIDGE_API_URL: z.string().url().default("https://testnet.api.bridge.nearone.org"),
  OMNIROLES_PROPOSAL_BOND_YOCTO: z.string().regex(/^\d+$/).default("100000000000000000000000"),
  /** Euthyna Market. Enabled when the market relayer is set: a dedicated account, never the company relayer. */
  // Rob the Agent (/v1/rob): Ruggy's account and its full-access key, the demo company, the two suppliers (ours).
  ROB_RUGGY_ACCOUNT_ID: z.string().optional(),
  ROB_RUGGY_PRIVATE_KEY: z.string().optional(),
  ROB_VAULT_ACCOUNT_ID: z.string().optional(),
  ROB_DAO_ACCOUNT_ID: z.string().optional(),
  ROB_TOKEN_ACCOUNT_ID: z.string().default("test-ft-v4.mandateos-root-20261021.testnet"),
  ROB_SUPPLIERS: z.string().optional(),
  /** Must answer send_tx (EXECUTED_OPTIMISTIC) with the reason of an invalid transaction; FastNEAR does, in about 2 s. */
  ROB_RPC_URL: z.string().url().default("https://test.rpc.fastnear.com"),
  ROB_MAX_ACTIVE_KEYS: z.coerce.number().int().min(1).default(300),
  /** Cards X and XI: the demo company's three owners, "account:ed25519:…" comma-separated (the third is the council bot). */
  ROB_OWNER_KEYS: z.string().optional(),
  /** Look Legit: Ruggy's two Base Sepolia suppliers (role "base-payments" of Rob the Agent Co.). */
  ROB_BASE_SUPPLIERS: z.string().default("0x770FEe7954f3FC813AD65d33dAb0D9cc696a2702,0xd63f3e36Dd87e8f8d480Bfe8093b708887156595"),
  /** Rug O'Clock: an OpenAI-compatible LLM (chat completions with tools); falls back to LLM_*. Off unless URL, key and model are set. */
  ROB_LLM_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  ROB_LLM_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  ROB_LLM_MODEL: z.preprocess(emptyToUndefined, z.string().optional()),
  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  LLM_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  LLM_MODEL: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * Rob the Agent's $LEASH testnet trophy: the Leash token (contracts/leash, Ruggy mints) deployed by scripts/rob-leash.mjs.
   * Set, a player who claims their plays with a wallet gets 1 LEASH, once. Empty: claims link plays, no trophy.
   */
  ROB_LEASH_TOKEN: z.preprocess((value) => (value === "" ? undefined : value), z.string().regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "ROB_LEASH_TOKEN must be a NEAR account id").optional()),
  ...robHireFields,
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
  /**
   * Founder seat recovery: the recovery contract (contracts/email-recovery) that verifies the
   * ZK Email proofs and runs the waiting period. Default on testnet: euthyna-recovery-v4.testnet.
   */
  RECOVERY_CONTRACT_ID: z.string().optional(),
  /** contracts/sealed-orders; unset turns sealed orders off in the console. */
  SEALED_ORDERS_ACCOUNT_ID: z.string().optional(),
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
  if (parsed.ROB_RUGGY_ACCOUNT_ID) {
    if (!parsed.ROB_RUGGY_PRIVATE_KEY || !parsed.ROB_VAULT_ACCOUNT_ID || !parsed.ROB_DAO_ACCOUNT_ID || (parsed.ROB_SUPPLIERS ?? "").split(",").filter(Boolean).length !== 2) {
      throw new Error("Rob the Agent needs ROB_RUGGY_PRIVATE_KEY, ROB_VAULT_ACCOUNT_ID, ROB_DAO_ACCOUNT_ID and two ROB_SUPPLIERS");
    }
    if (parsed.NEAR_NETWORK_ID !== "testnet") throw new Error("Rob the Agent runs on testnet only");
    if (parsed.ROB_OWNER_KEYS && parsed.ROB_OWNER_KEYS.split(",").filter((item) => /^[a-z0-9._-]+:ed25519:\w+$/.test(item.trim())).length !== 3) {
      throw new Error("ROB_OWNER_KEYS must be three account:ed25519:<secret> entries");
    }
    if (parsed.ROB_LEASH_TOKEN && [parsed.ROB_TOKEN_ACCOUNT_ID, parsed.ROB_VAULT_ACCOUNT_ID, parsed.ROB_DAO_ACCOUNT_ID, parsed.ROB_RUGGY_ACCOUNT_ID].includes(parsed.ROB_LEASH_TOKEN)) {
      throw new Error("ROB_LEASH_TOKEN must be its own token contract, not the vault's TestUSDC, the vault, the DAO or Ruggy");
    }
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
