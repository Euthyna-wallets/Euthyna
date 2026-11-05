#!/usr/bin/env node
/**
 * Rob the Agent: deploy the $LEASH testnet trophy token (docs/rob-the-agent.md, "Claim and Hall of thieves").
 *
 * Deploys contracts/res/test_ft.wasm (contracts/test-ft: NEP-141, open mint, no owner) on a testnet account and
 * initialises it, then prints the ROB_LEASH_TOKEN line for the API. Idempotent: an account that already runs the
 * token is left as is. Testnet only.
 *
 *   # the token account exists, with a full-access key you hold:
 *   LEASH_ACCOUNT_ID=leash-euthyna.testnet LEASH_PRIVATE_KEY=ed25519:… node scripts/rob-leash.mjs
 *
 *   # or create it as a sub-account of a parent you hold (funded with LEASH_FUND_NEAR, default 2.5):
 *   LEASH_ACCOUNT_ID=leash.ruggy-euthyna.testnet LEASH_PARENT_PRIVATE_KEY=ed25519:… node scripts/rob-leash.mjs
 *
 * Arguments override the environment: --account <id> --wasm <path> --rpc <url> --dry-run --lock.
 *   --dry-run  read the chain and print the plan, send nothing.
 *   --lock     after deploying, delete the account's full-access key: nobody can redeploy the token. Irreversible.
 *
 * Name and symbol: the test-ft wasm's ft_metadata is fixed in its code ("MandateOS Test USDC", TestUSDC, 6
 * decimals); this script cannot set "Leash"/"LEASH" on it. It deploys the wasm given by --wasm / LEASH_WASM, and
 * warns when the deployed metadata is not symbol LEASH. The API reads the decimals from ft_metadata and mints
 * 1 whole token (10^decimals base units) per trophy.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { connect, keyStores, KeyPair, utils } = require("near-api-js");

const { values: args } = parseArgs({
  options: {
    account: { type: "string" },
    wasm: { type: "string" },
    rpc: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    lock: { type: "boolean", default: false },
  },
});

const ACCOUNT = args.account ?? process.env.LEASH_ACCOUNT_ID;
const WASM = args.wasm ?? process.env.LEASH_WASM ?? new URL("../contracts/res/test_ft.wasm", import.meta.url).pathname;
const RPC = args.rpc ?? process.env.LEASH_RPC_URL ?? "https://test.rpc.fastnear.com";
const FUND = process.env.LEASH_FUND_NEAR ?? "2.5";
const DRY = args["dry-run"];
const NETWORK = "testnet";

if (!ACCOUNT || !/^[a-z0-9._-]+\.testnet$/.test(ACCOUNT)) throw new Error("set LEASH_ACCOUNT_ID (or --account) to a .testnet account");
if (!process.env.LEASH_PRIVATE_KEY && !process.env.LEASH_PARENT_PRIVATE_KEY) throw new Error("set LEASH_PRIVATE_KEY (the token account's key) or LEASH_PARENT_PRIVATE_KEY (to create it)");

const code = readFileSync(WASM);
const parent = ACCOUNT.split(".").slice(1).join(".");
const parentKey = process.env.LEASH_PARENT_PRIVATE_KEY ? KeyPair.fromString(process.env.LEASH_PARENT_PRIVATE_KEY) : null;
const tokenKey = process.env.LEASH_PRIVATE_KEY ? KeyPair.fromString(process.env.LEASH_PRIVATE_KEY) : parentKey;

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey(NETWORK, ACCOUNT, tokenKey);
if (parentKey) await keyStore.setKey(NETWORK, parent, parentKey);
const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore });

async function rpc(method, params) {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "leash", method, params }) });
  const body = await response.json();
  if (body.error || body.result?.error) throw new Error(JSON.stringify(body.error ?? body.result.error));
  return body.result;
}
async function view(method, viewArgs = {}) {
  const result = await rpc("query", { request_type: "call_function", finality: "final", account_id: ACCOUNT, method_name: method, args_base64: Buffer.from(JSON.stringify(viewArgs)).toString("base64") });
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}
const state = await rpc("query", { request_type: "view_account", finality: "final", account_id: ACCOUNT }).catch((error) => {
  if (/UNKNOWN_ACCOUNT|does not exist/.test(String(error))) return null;
  throw error;
});
const initialised = state && state.code_hash !== "11111111111111111111111111111111" ? await view("ft_total_supply").then(() => true, () => false) : false;

const plan = [
  !state ? `create ${ACCOUNT} from ${parent} with ${FUND} NEAR, key ${tokenKey.getPublicKey().toString()}` : null,
  !initialised && (!state || state.code_hash === "11111111111111111111111111111111") ? `deploy ${WASM} (${code.length} bytes)` : null,
  !initialised ? "call new()" : null,
  args.lock ? `delete the full-access key ${tokenKey.getPublicKey().toString()} (irreversible)` : null,
].filter(Boolean);
if (state && state.code_hash !== "11111111111111111111111111111111" && !initialised) {
  throw new Error(`${ACCOUNT} already runs a contract that is not an initialised NEP-141: pick another account`);
}
console.log(`$LEASH on ${ACCOUNT} (${RPC})`);
console.log(plan.length ? plan.map((step) => `  - ${step}`).join("\n") : "  - nothing to do: the token is already deployed");
if (DRY) process.exit(0);

if (!state) {
  if (!parentKey) throw new Error(`${ACCOUNT} does not exist: set LEASH_PARENT_PRIVATE_KEY for ${parent} to create it`);
  await (await near.account(parent)).createAccount(ACCOUNT, tokenKey.getPublicKey(), BigInt(utils.format.parseNearAmount(FUND)));
  console.log(`created ${ACCOUNT}`);
}
const token = await near.account(ACCOUNT);
if (!initialised) {
  if (!state || state.code_hash === "11111111111111111111111111111111") {
    const deployed = await token.deployContract(code);
    console.log(`deployed: ${deployed.transaction.hash}`);
  }
  const init = await token.functionCall({ contractId: ACCOUNT, methodName: "new", args: {}, gas: 30_000_000_000_000n });
  console.log(`initialised: ${init.transaction.hash}`);
}
if (args.lock) {
  const removed = await token.deleteKey(tokenKey.getPublicKey());
  console.log(`full-access key deleted: ${removed.transaction.hash}`);
}

const metadata = await view("ft_metadata");
console.log(`ft_metadata: ${metadata.name} (${metadata.symbol}), ${metadata.decimals} decimals`);
if (metadata.symbol !== "LEASH") {
  console.warn(`warning: the deployed metadata says ${metadata.symbol}, not LEASH: test-ft's metadata is fixed in its code. Wallets will show ${metadata.symbol}.`);
}
console.log(`\nAPI environment:\nROB_LEASH_TOKEN=${ACCOUNT}`);
