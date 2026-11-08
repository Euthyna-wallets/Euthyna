// Release check for the bank signer: run the WASM locally (wasmtime) against the partner's
// sandbox and pay a fresh payee TWICE on each rail. A payee the partner already saved must
// still be paid (the bug this catches: Pix refused the form on its second payout).
//
//   node bank-signer/scripts/sandbox-twice.mjs <wasmtime> <wasm built with --features dev-unsigned>
//   env: NOAH_API_KEY (sandbox key that needs no request signature), CUSTOMER_ID, VAULT, SOURCE_ADDRESS
//
// wasmtime does not trust a proxy's CA: requests go through a local plain-HTTP forwarder.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";

const { payeeVote } = await import(new URL("../../packages/sdk/dist/bank-private.js", import.meta.url).href);
const [wasmtime, wasm] = process.argv.slice(2);
const { NOAH_API_KEY, CUSTOMER_ID, VAULT, SOURCE_ADDRESS } = process.env;
if (!wasmtime || !wasm || !NOAH_API_KEY || !CUSTOMER_ID || !VAULT || !SOURCE_ADDRESS) throw new Error("usage: see the header");

const forwarder = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !["host", "connection", "content-length", "transfer-encoding"].includes(key)));
    const answer = await fetch(`https://api.sandbox.noah.com${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await answer.arrayBuffer()));
  } catch {
    res.writeHead(502);
    res.end();
  }
}).listen(0, "127.0.0.1");
await new Promise((resolve) => forwarder.once("listening", resolve));
const port = forwarder.address().port;

const env = {
  PROTECTED_NOAH_SEED: randomBytes(32).toString("hex"), NOAH_API_KEY, NOAH_DEV_UNSIGNED: "1", NOAH_API_URL: `http://127.0.0.1:${port}/v1`,
  OUTLAYER_EXECUTION_TYPE: "NEAR", NEAR_PREDECESSOR_ID: VAULT, NOAH_SEPA_CHANNEL_ID: "831e59d9-4826-5d7b-8f91-07fd62ba5ad4",
};
// Asynchronous: the forwarder above answers the WASM's requests from this same process.
const run = (input) => new Promise((resolve, reject) => {
  const child = spawn(wasmtime, ["run", "-S", "http", ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), wasm]);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.on("error", reject);
  child.on("close", () => { try { resolve(JSON.parse(out)); } catch { reject(new Error(`no JSON from the signer: ${out.slice(0, 200)}`)); } });
  child.stdin.end(JSON.stringify(input));
});
const box = (await run({ op: "pubkey" })).box_public_key_hex;
const tag = randomBytes(3).toString("hex");
const rails = [
  ["pix", "a66e5007-3965-51d4-8b34-73eaf3590c05", { firstName: "Rui", lastName: "Lima", pixType: "Email", pixKey: `rui.lima.${tag}@example.com` }],
  ["sepa", "831e59d9-4826-5d7b-8f91-07fd62ba5ad4", { name: "Atelier Dupont SAS", holderType: "Business", iban: "FR76 3000 6000 0112 3456 7890 189" }],
];
let failed = 0;
for (const [rail, channelId, values] of rails) {
  const vote = await payeeVote({ vault: VAULT, rail, channelId, values, boxKeyHex: box, readers: [{ account: "check.testnet", publicKey: randomBytes(32).toString("base64") }] });
  for (const n of [1, 2]) {
    const out = await run({
      op: "payout", vault: VAULT, customer_id: CUSTOMER_ID, commitment: vote.commitment, sealed: vote.sealedForSigner, reference: `CHECK-${tag}-${n}`,
      crypto_amount: "5", source_address: SOURCE_ADDRESS, network: "BaseTestSepolia", crypto: "EURC_TEST", nonce: randomBytes(16).toString("hex"),
      expiry: new Date(Date.now() + 15 * 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
    });
    console.log(`${rail} payout ${n}: ${out.ok ? `ok (${out.fiat_amount})` : `REFUSED: ${out.error}`}`);
    if (!out.ok) failed += 1;
  }
}
forwarder.close();
process.exit(failed ? 1 : 0);
