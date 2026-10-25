#!/usr/bin/env node
// Attacks a live vault on NEAR testnet with view calls only: no key, no gas,
// nothing moves. `check_operation` runs the exact rules `prepare` enforces, so
// a refusal here is the refusal the agent would get on chain.
//
//   VAULT=acme-ai-vault.mandateos.testnet AGENT=<agent account> ROLE=payments pnpm attack:testnet
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const VAULT = process.env.VAULT ?? "acme-ai-vault.mandateos.testnet";
const AGENT = process.env.AGENT ?? "naomi-83d781-agent.mandateos.testnet";
const ROLE = process.env.ROLE ?? "payments";
const ATTACKER = "babababababababababababababababababababa";

async function rpc(params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }),
  });
  const body = await response.json();
  if (body.error || body.result?.error) throw new Error(JSON.stringify(body.error ?? body.result.error));
  return body.result;
}

async function view(method, args = {}) {
  const result = await rpc({
    request_type: "call_function",
    account_id: VAULT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(result.result).toString());
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const word = (value) => value.toString(16).padStart(64, "0");
const transfer = (to, amount) => [...Buffer.from(`a9059cbb${"0".repeat(24)}${to}${word(amount)}`, "hex")];

const role = await view("get_role", { role: ROLE });
if (!role) throw new Error(`role ${ROLE} not found on ${VAULT}`);
const permission = role.config.permissions.find((item) => hex(item.selector ?? []) === "a9059cbb");
if (!permission) throw new Error(`role ${ROLE} has no ERC-20 transfer permission`);
const recipient = permission.conditions.find((node) => node.operator === 16)?.compValue.slice(-40);
const budgetKey = permission.conditions.find((node) => node.operator === 28)?.compValue.slice(2);
const allowance = await view("get_allowance", { key: [...Buffer.from(budgetKey, "hex")] });
const left = BigInt(allowance?.balance ?? 0);

const base = (reference, amount, calldata = transfer(recipient, amount)) => ({
  chain_id: permission.chain_id,
  target: permission.target,
  value: "0",
  calldata,
  allowance_amount: amount.toString(),
  reference,
  gas_limit: "120000",
  max_fee_per_gas: "20000000000",
  max_priority_fee_per_gas: "1000000000",
});

const control = await view("check_operation", { role: ROLE, member: AGENT, request: base(`CONTROL-${Date.now()}`, 1n) });
console.log(`Vault ${VAULT}, role "${ROLE}", agent ${AGENT}`);
const controlNote = control.allowed
  ? "allowed"
  : String(control.reason).includes("allowanceExceeded")
    ? "refused: the budget is used up for this period (the attacks below are refused for their own reason)"
    : `refused (${control.reason})`;
console.log(`Control: honest payment of 1 unit to 0x${recipient}: ${controlNote}\n`);

const approve = [...Buffer.from(`095ea7b3${"0".repeat(24)}${ATTACKER}${"f".repeat(64)}`, "hex")];
const attacks = [
  ["prompt-injected agent pays the attacker", AGENT, base("ATK-1", 1n, transfer(ATTACKER, 1n)), "parameterNotAllowed"],
  ["amount past what is left of the budget", AGENT, base("ATK-2", left + 1n), "allowanceExceeded"],
  ["agent declares less than the calldata moves", AGENT, { ...base("ATK-3", 1n), calldata: transfer(recipient, left + 450_000n) }, "ERR_ALLOWANCE_AMOUNT_MISMATCH"],
  ["agent approves the attacker", AGENT, base("ATK-4", 0n, approve), "FunctionNotAllowed"],
  ["agent calls another contract", AGENT, { ...base("ATK-5", 1n), target: Array(20).fill(0x42) }, "TargetNotAllowed"],
  ["agent attaches native ETH", AGENT, { ...base("ATK-6", 1n), value: "1000000000000000000" }, "SendNotAllowed"],
  ["account without the role pays", "attacker.testnet", base("ATK-7", 1n), "ERR_MEMBERSHIP_NOT_FOUND"],
];

let failures = 0;
for (const [attack, member, request, expected] of attacks) {
  const result = await view("check_operation", { role: ROLE, member, request });
  const ok = !result.allowed && String(result.reason).includes(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${attack}\n    ${result.allowed ? "ALLOWED" : result.reason.slice(0, 120)}`);
}

const keys = await rpc({ request_type: "view_access_key_list", account_id: VAULT });
const owner = await view("owner_id");
const keyless = keys.keys.length === 0;
if (!keyless) failures += 1;
console.log(`${keyless ? "✓" : "✗"} nobody can sign as the vault\n    ${keys.keys.length} access keys; owner is ${owner}`);
console.log(`\n${attacks.length + 1 - failures} of ${attacks.length + 1} attacks refused by the live vault.`);
process.exit(failures ? 1 : 0);
