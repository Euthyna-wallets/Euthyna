#!/usr/bin/env node
// Rob the Agent, « Hire him »: puts Ruggy's tx-check listing on the Euthyna Market, once.
//
//   Seller  Rob the Agent Co. (the organization whose treasury is ROB_VAULT_ACCOUNT_ID)
//   payTo   ROB_VAULT_ACCOUNT_ID (the Rob vault, already registered on the test token)
//   asset   ROB_TOKEN_ACCOUNT_ID (TestUSDC, 6 decimals), price 1 TestUSDC = 1000000
//   SLA     120 s (the API delivers it in-process, in seconds)
//
// It writes the listing in the database and prints a new delivery token for ROB_HIRE_DELIVERY_TOKEN.
// It sends nothing on NEAR; it only reads, with a view call, that the vault is registered on the token.
//
// Without --apply it only prints what it would do. Flags:
//   --apply           write
//   --org <id>        the seller organization, if it cannot be found from the vault's treasury
//   --create-company  no organization found: create « Rob the Agent Co. » (slug rob-the-agent-co, no members)
//   --rotate          the listing already has a delivery token: replace it (the old one stops working)
//
//   DATABASE_URL=… ROB_VAULT_ACCOUNT_ID=rob-the-agent-co.nomos.euthyna.testnet node scripts/rob-hire-setup.mjs
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { PrismaClient } = require("@prisma/client");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const apply = flag("--apply");

const vault = process.env.ROB_VAULT_ACCOUNT_ID;
const token = process.env.ROB_TOKEN_ACCOUNT_ID || "test-ft-v4.mandateos-root-20261021.testnet";
const handle = process.env.ROB_HIRE_HANDLE || "ruggy-tx-check";
const rpcUrl = process.env.ROB_RPC_URL || "https://test.rpc.fastnear.com";
if (!process.env.DATABASE_URL || !vault) {
  console.error("Set DATABASE_URL and ROB_VAULT_ACCOUNT_ID (the Rob vault).");
  process.exit(1);
}

const listing = {
  handle,
  title: "Check a transaction before you sign it",
  description:
    "Ruggy, the agent of Rob the Agent Co., reads an EVM transaction and says in plain English what it does and what could go wrong: " +
    "unlimited approvals, approvals for every NFT, ownership hand-overs, contract upgrades, unknown functions. " +
    "Decoded locally from the calldata, deterministic; not a simulation.",
  category: "security",
  priceAtomic: "1000000",
  asset: token,
  payTo: vault,
  slaSeconds: 120,
  inputHint: '{"chainId":84532,"to":"0x…","data":"0x…","value":"0"}',
  outputHint: "A markdown report and JSON: what the call does, and its risks by severity.",
};

async function view(accountId, method, viewArgs) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: accountId, method_name: method, args_base64: Buffer.from(JSON.stringify(viewArgs)).toString("base64") } }),
  });
  const body = await response.json();
  if (body.error || body.result?.error) throw new Error(JSON.stringify(body.error ?? body.result.error));
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
}

const prisma = new PrismaClient();
try {
  // 1. The vault must be able to receive the token, or the cheque would fail after the work.
  if ((await view(token, "storage_balance_of", { account_id: vault })) === null) {
    throw new Error(`${vault} is not registered on ${token}: vote NearStorageDeposit first`);
  }
  console.log(`✓ ${vault} is registered on ${token}`);

  // 2. The seller: Rob the Agent Co.
  let organizationId = option("--org");
  if (!organizationId) {
    const treasury = await prisma.treasury.findFirst({ where: { vaultAccountId: vault } });
    organizationId = treasury?.organizationId;
  }
  if (!organizationId) {
    const bySlug = await prisma.organization.findUnique({ where: { slug: "rob-the-agent-co" } });
    organizationId = bySlug?.id;
  }
  if (!organizationId) {
    if (!flag("--create-company")) throw new Error(`no organization has the treasury ${vault}: pass --org <id>, or --create-company`);
    organizationId = randomUUID();
    console.log(`+ organization « Rob the Agent Co. » ${organizationId} (slug rob-the-agent-co, no members)`);
    if (apply) await prisma.organization.create({ data: { id: organizationId, name: "Rob the Agent Co.", slug: "rob-the-agent-co", createdAt: new Date() } });
  } else {
    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!organization) throw new Error(`organization ${organizationId} not found`);
    console.log(`✓ seller: ${organization.name} (${organizationId})`);
  }

  // 3. The listing: the handle, the asset and the payee never change.
  const existing = await prisma.marketListing.findUnique({ where: { handle } });
  if (existing && (existing.organizationId !== organizationId || existing.payTo !== vault || existing.asset !== token)) {
    throw new Error(`the handle ${handle} is taken by another listing (${existing.organizationId}, pays ${existing.payTo} in ${existing.asset}): set ROB_HIRE_HANDLE`);
  }
  const rotate = !existing?.deliveryTokenHash || flag("--rotate");
  const deliveryToken = `mdt_${randomBytes(32).toString("base64url")}`;
  const fields = { ...listing, status: "live", ...(rotate ? { deliveryTokenHash: createHash("sha256").update(deliveryToken).digest("hex") } : {}) };
  console.log(`${existing ? "~ update" : "+ create"} listing ${handle}: ${listing.title}, 1 TestUSDC to ${vault}, SLA ${listing.slaSeconds} s, live`);
  if (apply) {
    if (existing) {
      const { handle: _handle, asset: _asset, payTo: _payTo, ...changes } = fields;
      await prisma.marketListing.update({ where: { id: existing.id }, data: changes });
    } else {
      await prisma.marketListing.create({ data: { ...fields, organizationId } });
    }
  }
  if (!apply) {
    console.log("\nDry run: nothing written. Run again with --apply.");
  } else if (rotate) {
    console.log(`\nSet in the API's environment, then restart it (shown once):\nROB_HIRE_DELIVERY_TOKEN=${deliveryToken}`);
  } else {
    console.log("\nThe listing keeps its delivery token (pass --rotate for a new one).");
  }
} catch (error) {
  console.error(`✕ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
