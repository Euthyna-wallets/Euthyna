#!/usr/bin/env node
/**
 * Can a function-call access key, limited to `ft_transfer` on a token, sign a
 * NEP-366 delegate action whose inner call attaches 1 yoctoNEAR (as NEP-141
 * `ft_transfer` requires)? Runs against a local NEAR sandbox.
 *
 *   near-sandbox --home /tmp/probe init && near-sandbox --home /tmp/probe run --rpc-addr 127.0.0.1:3031
 *   node scripts/fc-key-delegate-probe.mjs http://127.0.0.1:3031 /tmp/probe/validator_key.json contracts/res/test_ft.wasm
 *
 * Cases, each relayed by a separate account:
 *   A. full-access key, ft_transfer with 1 yocto        -> expected to pass (control)
 *   B. function-call key, ft_transfer with 1 yocto      -> the question
 *   C. function-call key, ft_transfer with 0 yocto      -> shows the key itself is accepted
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { connect, keyStores, KeyPair, transactions, utils } = require("near-api-js");

const [rpc, validatorKeyFile, ftWasm] = process.argv.slice(2);
if (!rpc || !validatorKeyFile || !ftWasm) throw new Error("usage: fc-key-delegate-probe.mjs <rpc> <validator_key.json> <test_ft.wasm>");

const validator = JSON.parse(readFileSync(validatorKeyFile, "utf8"));
const root = validator.account_id;
const NETWORK = "sandbox";
const NEAR = (n) => BigInt(utils.format.parseNearAmount(String(n)));

async function connection(keys) {
  const keyStore = new keyStores.InMemoryKeyStore();
  for (const [accountId, keyPair] of Object.entries(keys)) await keyStore.setKey(NETWORK, accountId, keyPair);
  return connect({ networkId: NETWORK, nodeUrl: rpc, keyStore });
}

const rootKey = KeyPair.fromString(validator.secret_key ?? validator.private_key);
const tag = Date.now().toString(36);
const ft = `ft-${tag}.${root}`;
const card = `card-${tag}.${root}`;
const relayer = `relayer-${tag}.${root}`;
const receiver = `receiver-${tag}.${root}`;
const cardFull = KeyPair.fromRandom("ed25519");
const cardFc = KeyPair.fromRandom("ed25519");
const relayerKey = KeyPair.fromRandom("ed25519");

const admin = await (await connection({ [root]: rootKey })).account(root);
await admin.createAccount(ft, rootKey.getPublicKey(), NEAR(10));
const near = await connection({ [root]: rootKey, [ft]: rootKey, [card]: cardFull, [relayer]: relayerKey });
const ftAccount = await near.account(ft);
await ftAccount.deployContract(readFileSync(ftWasm));
await ftAccount.functionCall({ contractId: ft, methodName: "new", args: {} });
await admin.createAccount(card, cardFull.getPublicKey(), NEAR(1));
await admin.createAccount(relayer, relayerKey.getPublicKey(), NEAR(5));
await admin.createAccount(receiver, rootKey.getPublicKey(), NEAR(1));
for (const account of [card, receiver]) await ftAccount.functionCall({ contractId: ft, methodName: "mint", args: { account_id: account, amount: account === card ? "1000" : "0" } });
const cardAccount = await near.account(card);
await cardAccount.addKey(cardFc.getPublicKey(), ft, ["ft_transfer"], NEAR(0.25));

const balance = async () => (await ftAccount.viewFunction({ contractId: ft, methodName: "ft_balance_of", args: { account_id: receiver } }));

async function relay(label, keyPair, deposit) {
  const signerNear = await connection({ [card]: keyPair });
  const signer = await signerNear.account(card);
  const before = await balance();
  try {
    const signedDelegate = await signer.signedDelegate({
      receiverId: ft,
      blockHeightTtl: 120,
      actions: [transactions.functionCall("ft_transfer", { receiver_id: receiver, amount: "1" }, 30_000_000_000_000n, deposit)],
    });
    const outcome = await (await near.account(relayer)).signAndSendTransaction({ receiverId: card, actions: [new transactions.Action({ signedDelegate })] });
    const failures = [outcome.status, ...outcome.receipts_outcome.map((receipt) => receipt.outcome.status)]
      .filter((status) => status && typeof status === "object" && "Failure" in status)
      .map((status) => JSON.stringify(status.Failure));
    const after = await balance();
    console.log(JSON.stringify({ case: label, deposit: deposit.toString(), relayed: true, transferred: BigInt(after) > BigInt(before), failures }));
  } catch (error) {
    console.log(JSON.stringify({ case: label, deposit: deposit.toString(), relayed: false, transferred: false, error: String(error?.type ?? "") + " " + String(error?.message ?? error).slice(0, 400) }));
  }
}

await relay("A full-access key, 1 yocto", cardFull, 1n);
await relay("B function-call key, 1 yocto", cardFc, 1n);
await relay("C function-call key, 0 yocto", cardFc, 0n);
