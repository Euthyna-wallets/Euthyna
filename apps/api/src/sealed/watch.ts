/**
 * Sealed orders from the command line, for whoever holds an order (a member, or an agent's operator).
 *
 *   pnpm --filter @euthyna/api sealed place --key agent.json --vault <vault> --role <role> --price 1800 --cap 50 --days 7 [--approve 20] > order.json
 *     A member of the role (an agent) places an order directly: the router approval when asked, then
 *     the seal, with the terms encrypted for the members who registered a reading key. Prints the
 *     order file: keep it private, it is the only copy of the terms outside the members' keys.
 *   pnpm --filter @euthyna/api sealed watch order.json --key watcher.json [--chunk 5] [--every 60] [--settle-minutes 40] [--once]
 *     Watches the market and fills when it meets the hidden limit: proves, sends `fill`, broadcasts
 *     the signed swap to Base and settles it on the vault. `--key`: NEAR credentials
 *     ({account_id, private_key}) of any account with a little NEAR (it pays gas only).
 * Env: NEAR_RPC_URL, BASE_SEPOLIA_RPC_URL, SEALED_ORDERS_ACCOUNT_ID.
 */
import { readFileSync, writeFileSync } from "node:fs";

// `place` prints the order file on stdout; near-api-js logs receipts with console.log.
console.log = console.info = console.debug = console.error.bind(console);

import { parseUnits } from "viem";
import { DEFAULT_SEALED_ACCOUNT, SealedAgent, type OrderFile } from "@euthyna/sdk/sealed-agent";

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}
function required(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function agentOf(args: string[], sealedAccountId?: string) {
  const credentials = JSON.parse(readFileSync(required(args, "key"), "utf8")) as { account_id: string; private_key?: string; secret_key?: string };
  return SealedAgent.connect({
    accountId: credentials.account_id,
    privateKey: (credentials.private_key ?? credentials.secret_key)!,
    ...(process.env.NEAR_RPC_URL ? { nearRpc: process.env.NEAR_RPC_URL } : {}),
    ...(process.env.BASE_SEPOLIA_RPC_URL ? { baseRpc: process.env.BASE_SEPOLIA_RPC_URL } : {}),
    sealedAccountId: sealedAccountId ?? process.env.SEALED_ORDERS_ACCOUNT_ID ?? DEFAULT_SEALED_ACCOUNT,
  });
}

async function place(args: string[]) {
  const agent = await agentOf(args);
  const { file, transactions } = await agent.place({
    vault: required(args, "vault"),
    role: required(args, "role"),
    maxPriceUsdc: Number(required(args, "price")),
    capUsdc: required(args, "cap"),
    days: Number(flag(args, "days") ?? 7),
    ...(flag(args, "approve") ? { approveUsdc: flag(args, "approve")! } : {}),
  });
  process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
  process.stderr.write(`order #${file.id} sealed (${file.commitment}); NEAR transactions: ${transactions.join(", ")}\n`);
}

async function watch(args: string[]) {
  const path = args[0];
  if (!path) throw new Error("usage: sealed watch <order.json> --key <credentials.json>");
  const file = JSON.parse(readFileSync(path, "utf8")) as OrderFile;
  const agent = await agentOf(args, file.sealedAccountId);
  const chunk = flag(args, "chunk") ? parseUnits(flag(args, "chunk")!, 6) : undefined;
  const every = Number(flag(args, "every") ?? 60) * 1000;
  const settleMinutes = Number(flag(args, "settle-minutes") ?? 40);
  const stamp = () => new Date().toISOString();
  const keep = () => writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  for (;;) {
    // The router approval placed with the order, and swaps sent earlier: settle them once final.
    const still: number[][] = [];
    for (const opId of file.pending ?? []) {
      const state = await agent.settle(file.vault, opId, 0);
      console.log(`${stamp()} earlier operation ${state}`);
      if (state === "PossiblySigned") still.push(opId);
    }
    if ((file.pending ?? []).length !== still.length) { file.pending = still; keep(); }
    const result = await agent.tick(file, chunk);
    if (result.status === "filled") {
      console.log(`${stamp()} filled ${result.amountIn} at rate ${result.rate}: NEAR tx ${result.transaction}`);
      // The vault settles a Base operation only on a finalized block (about 20 minutes on Base Sepolia).
      const state = await agent.settle(file.vault, result.opId, settleMinutes);
      if (state === "PossiblySigned") { file.pending = [...(file.pending ?? []), result.opId]; keep(); }
      console.log(state === "PossiblySigned"
        ? `${stamp()} swap sent, Base block not final yet; it settles on the next run`
        : `${stamp()} swap ${state}`);
    } else if (result.status === "no-funds") {
      console.log(`${stamp()} the wallet holds ${result.balance} of the token to sell, under the ${result.amountIn} to fill`);
    } else if (result.status === "needs-approval") {
      console.log(`${stamp()} the router may take ${result.allowance} of the wallet's USDC, under the ${result.amountIn} to fill; approve more within the role`);
    } else if (result.status === "waiting") {
      // Printed on this machine only: the limit never leaves it.
      console.log(`${stamp()} waiting: market rate ${result.marketRate} under the limit`);
    } else {
      console.log(`${stamp()} ${result.status}${"reason" in result ? `: ${result.reason}` : ""}`);
      if (result.status !== "refused") break;
    }
    if (args.includes("--once")) break;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

const [command, ...rest] = process.argv.slice(2);
const run = command === "place" ? place : command === "watch" ? watch : null;
if (!run) {
  console.error("usage: sealed place|watch … (see the top of src/sealed/watch.ts)");
  process.exit(2);
}
await run(rest);
process.exit(0);
