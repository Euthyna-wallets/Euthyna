#!/usr/bin/env node
// Re-reads every transaction and state check of docs/evidence/<network>.json from public RPCs (NEAR,
// Base Sepolia, Solana devnet) and reports any mismatch. With --write, also regenerates
// docs/EVIDENCE.md from what it read: that file is never edited by hand.
//
//   node scripts/evidence.mjs                 # check, exit 1 on any mismatch
//   node scripts/evidence.mjs --write         # check and regenerate docs/EVIDENCE.md
//
// No install, no key: Node 22 and the network.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const network = process.argv.find((arg) => arg.startsWith("--network="))?.slice(10) ?? "testnet";
const write = process.argv.includes("--write");
const evidence = JSON.parse(readFileSync(join(root, "docs/evidence", `${network}.json`), "utf8"));
const RPC = { ...evidence.rpc, ...(process.env.NEAR_RPC ? { near: process.env.NEAR_RPC } : {}) };
/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 300));
      return body.result;
    } catch (error) {
      // Public RPCs rate-limit (HTTP 429): wait longer each time.
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
    }
  }
}

const lower = (value) => String(value).toLowerCase();
const word = (address) => `0x${lower(address).slice(2).padStart(64, "0")}`;

async function nearTransaction(item) {
  const result = await rpc(RPC.near, "EXPERIMENTAL_tx_status", { tx_hash: item.hash, sender_account_id: item.sender, wait_until: "FINAL" });
  const problems = [];
  const status = result.status;
  const failed = typeof status === "object" && status !== null && "Failure" in status;
  // A relayed call (NEP-366): the transaction succeeds even when the inner call fails; look at every receipt.
  const receiptFailure = result.receipts_outcome.map((receipt) => receipt.outcome.status).find((s) => s && typeof s === "object" && "Failure" in s);
  const anyFailure = failed || Boolean(receiptFailure);
  if (item.expect === "success" && anyFailure) problems.push(`expected success, got ${JSON.stringify(status.Failure ?? receiptFailure.Failure).slice(0, 200)}`);
  if (item.expect === "failure" && !anyFailure) problems.push("expected a refusal, the transaction succeeded");
  if (item.error && !JSON.stringify(status).concat(JSON.stringify(receiptFailure ?? "")).includes(item.error)) problems.push(`refusal does not say ${item.error}`);
  const tx = result.transaction;
  if (tx.signer_id !== item.sender) problems.push(`signed by ${tx.signer_id}`);
  if (item.receiver && tx.receiver_id !== item.receiver) problems.push(`sent to ${tx.receiver_id}`);
  if (item.method) {
    const methods = JSON.stringify(tx.actions);
    if (!methods.includes(`"method_name":"${item.method}"`)) problems.push(`no call to ${item.method}`);
  }
  return { problems, when: null };
}

async function baseTransaction(item) {
  const receipt = await rpc(RPC.base, "eth_getTransactionReceipt", [item.hash]);
  const problems = [];
  if (!receipt) return { problems: ["not found"] };
  if (receipt.status !== "0x1") problems.push(`status ${receipt.status}`);
  if (item.from && lower(receipt.from) !== lower(item.from)) problems.push(`sent by ${receipt.from}`);
  if (item.to && lower(receipt.to) !== lower(item.to)) problems.push(`sent to ${receipt.to}`);
  for (const transfer of item.transfers ?? []) {
    const found = receipt.logs.some((log) => lower(log.address) === lower(transfer.token) && lower(log.topics[0]) === TRANSFER
      && (!transfer.from || lower(log.topics[1]) === word(transfer.from))
      && (!transfer.to || lower(log.topics[2]) === word(transfer.to))
      && (!transfer.amount || BigInt(log.data) === BigInt(transfer.amount)));
    if (!found) problems.push(`no ${transfer.token.slice(0, 8)}… Transfer${transfer.from ? ` from ${transfer.from.slice(0, 8)}…` : ""}${transfer.to ? ` to ${transfer.to.slice(0, 8)}…` : ""}${transfer.amount ? ` of ${transfer.amount}` : ""}`);
  }
  return { problems };
}

async function solanaTransaction(item) {
  const tx = await rpc(RPC.solana, "getTransaction", [item.hash, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
  const problems = [];
  if (!tx) return { problems: ["not found"] };
  if (tx.meta.err !== null) problems.push(`error ${JSON.stringify(tx.meta.err)}`);
  const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey);
  if (item.feePayer && keys[0] !== item.feePayer) problems.push(`fee paid by ${keys[0]}`);
  if (item.tokenTo) {
    const received = (tx.meta.postTokenBalances ?? []).some((balance) => balance.owner === item.tokenTo
      && BigInt(balance.uiTokenAmount.amount) > BigInt((tx.meta.preTokenBalances ?? []).find((pre) => pre.accountIndex === balance.accountIndex)?.uiTokenAmount.amount ?? "0"));
    if (!received) problems.push(`${item.tokenTo.slice(0, 8)}… received no token`);
  }
  return { problems };
}

async function nearView(account, method, args) {
  const result = await rpc(RPC.near, "query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args ?? {})).toString("base64") });
  return Buffer.from(result.result).toString();
}

async function stateCheck(item) {
  const problems = [];
  let seen = "";
  if (item.check === "near-keys") {
    const { keys } = await rpc(RPC.near, "query", { request_type: "view_access_key_list", finality: "final", account_id: item.account });
    seen = keys.length === 0 ? "no access key" : keys.map((key) => key.access_key.permission === "FullAccess" ? "full access" : `function call → ${key.access_key.permission.FunctionCall.receiver_id}`).join(", ");
    if (item.expect.count !== undefined && keys.length !== item.expect.count) problems.push(`${keys.length} access key(s)`);
    if (item.expect.functionCallOnly) {
      for (const key of keys) {
        const permission = key.access_key.permission;
        if (permission === "FullAccess") problems.push("a full-access key");
        else if (!item.expect.functionCallOnly.includes(permission.FunctionCall.receiver_id)) problems.push(`a key for ${permission.FunctionCall.receiver_id}`);
      }
    }
  } else if (item.check === "near-view") {
    const text = await nearView(item.account, item.method, item.args);
    const flat = lower(text);
    const short = (needle) => (/^[0-9a-f]{40}$/i.test(needle) ? `0x${needle.slice(0, 6)}…${needle.slice(-4)}` : needle.replace(/"/g, ""));
    seen = item.expect.contains ? `has ${item.expect.contains.map(short).join(", ")}` : text.length > 120 ? `${text.slice(0, 117)}…` : text;
    for (const needle of item.expect.contains ?? []) if (!flat.includes(lower(needle))) problems.push(`does not contain ${needle}`);
    if (item.expect.nonEmpty) {
      const list = JSON.parse(text);
      seen = `${Array.isArray(list) ? list.length : 0} permission(s)`;
      if (!Array.isArray(list) || list.length === 0) problems.push("empty");
    }
    if (item.expect.minFilled !== undefined) {
      const orders = JSON.parse(text);
      const filled = orders.filter((order) => BigInt(order.filled) > 0n).length;
      seen = `${orders.length} orders, ${filled} filled; no price, size or deadline on chain`;
      if (filled < item.expect.minFilled) problems.push(`${filled} filled`);
    }
  } else if (item.check === "evm-code") {
    const code = await rpc(RPC.base, "eth_getCode", [item.address, "latest"]);
    seen = code;
    if (lower(code) !== lower(item.expect.equals)) problems.push(`code ${code.slice(0, 50)}`);
  }
  return { problems, seen };
}

const explorer = {
  near: (hash) => `https://testnet.nearblocks.io/txns/${hash}`,
  base: (hash) => `https://base-sepolia.blockscout.com/tx/${hash}`,
  solana: (hash) => `https://explorer.solana.com/tx/${hash}?cluster=devnet`,
};

const rows = [];
let bad = 0;
for (const item of evidence.transactions) {
  const check = item.chain === "near" ? nearTransaction : item.chain === "base" ? baseTransaction : solanaTransaction;
  const { problems } = await check(item).catch((error) => ({ problems: [String(error.message ?? error).slice(0, 200)] }));
  if (problems.length) bad += 1;
  rows.push({ ...item, problems });
  console.log(`${problems.length ? "✗" : "✓"} ${item.chain.padEnd(6)} ${item.hash.slice(0, 14)}… ${item.claim}${problems.length ? `\n    ${problems.join("; ")}` : ""}`);
}
const states = [];
for (const item of evidence.state) {
  const { problems, seen } = await stateCheck(item).catch((error) => ({ problems: [String(error.message ?? error).slice(0, 200)], seen: "" }));
  if (problems.length) bad += 1;
  states.push({ ...item, problems, seen });
  console.log(`${problems.length ? "✗" : "✓"} state  ${item.claim}${problems.length ? `\n    ${problems.join("; ")}` : ""}`);
}
const total = evidence.transactions.length + evidence.state.length;
console.log(`\n${total - bad} of ${total} match the chain`);

if (write) {
  const at = new Date().toISOString().slice(0, 16).replace("T", " ");
  const c = evidence.company;
  const cell = (text) => String(text).replace(/\|/g, "\\|");
  const lines = [
    "# Evidence",
    "",
    `Generated by \`node scripts/evidence.mjs --write\` from [docs/evidence/${network}.json](./evidence/${network}.json) on ${at} UTC: every`,
    "transaction and state below was read again from public RPCs (NEAR testnet archival, Base Sepolia, Solana devnet).",
    "Do not edit this file by hand; run the script. `node scripts/evidence.mjs` alone checks without writing and exits 1 on any",
    "mismatch.",
    "",
    `**${total - bad} of ${total} match the chain.**`,
    "",
    `Most of it is one company, **${c.name}**, walked through [JUDGE-PATH.md](../JUDGE-PATH.md) on 11 November: DAO \`${c.dao}\`,`,
    `vault \`${c.vault}\`, agent \`${c.agent}\`, shares \`${c.shares}\`, wallets \`${c.wallets["base-sepolia"]}\` (Base Sepolia) and`,
    `\`${c.wallets["solana-devnet"]}\` (Solana devnet). The refusals come from Rob the Agent ([docs/rob-the-agent.md](./rob-the-agent.md)), the`,
    "seat recovery from [docs/recovery.md](./recovery.md).",
    "",
    "## State, read now",
    "",
    "| Claim | Read from | Seen | |",
    "| --- | --- | --- | --- |",
    ...states.map((item) => `| ${cell(item.claim)} | \`${item.account ?? item.address}\`${item.method ? ` \`${item.method}\`` : ""} | ${cell(item.seen)} | ${item.problems.length ? `✗ ${cell(item.problems.join("; "))}` : "✓"} |`),
    "",
    "## Transactions",
    "",
    "| Part | Claim | Transaction | |",
    "| --- | --- | --- | --- |",
    ...rows.map((item) => `| ${item.part} | ${cell(item.claim)} | [\`${item.hash.slice(0, 10)}…\`](${explorer[item.chain](item.hash)}) (${item.chain === "base" ? "Base" : item.chain === "solana" ? "Solana" : "NEAR"}${item.expect === "failure" ? `, refused: \`${item.error}\`` : ""}) | ${item.problems.length ? `✗ ${cell(item.problems.join("; "))}` : "✓"} |`),
    "",
    "What each check asserts: a NEAR transaction's signer, receiver, method and outcome (a refusal must fail with the",
    "named error, and a relayed call must succeed in every receipt); a Base transaction's sender (Euthyna's relayer), the",
    "company wallet it ran on and its ERC-20 `Transfer` logs; a Solana transaction's fee payer, success and the token",
    "received. Testnet only, unaudited.",
    "",
  ];
  writeFileSync(join(root, "docs/EVIDENCE.md"), lines.join("\n"));
  console.log("docs/EVIDENCE.md written");
}
process.exit(bad ? 1 : 0);
