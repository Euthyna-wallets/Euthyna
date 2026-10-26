import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KeyPair, transactions, utils } from "near-api-js";
import { afterEach, describe, expect, it } from "vitest";

import { SignerAgentApi } from "./index.js";
import { SignerError, SignerSocket, SocketNearSigner } from "./signer-socket.js";

const AGENT = "naomi-agent.euthyna.testnet";
const VAULT = "acme-vault.euthyna.testnet";
const key = KeyPair.fromRandom("ed25519");
const servers: Server[] = [];
const dirs: string[] = [];

/** A stand-in for euthyna-signer: same protocol, signs with an in-test key. */
function fakeSigner(handler: (request: Record<string, unknown>) => Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "euthyna-"));
  dirs.push(dir);
  const path = join(dir, "signer.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end >= 0) socket.end(`${JSON.stringify(handler(JSON.parse(buffer.slice(0, end))))}\n`);
    });
  });
  server.listen(path);
  servers.push(server);
  return path;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("euthyna-signer client", () => {
  it("signs a near-api-js transaction through the socket, and the signature verifies", async () => {
    const seen: Record<string, unknown>[] = [];
    const path = fakeSigner((request) => {
      seen.push(request);
      if (request.op === "public_key") return { ok: true, public_key: key.getPublicKey().toString() };
      const bytes = Buffer.from(String(request.tx_borsh_b64), "base64");
      const { signature } = key.sign(new Uint8Array(createHash("sha256").update(bytes).digest()));
      return { ok: true, signature: `ed25519:${utils.serialize.base_encode(signature)}`, public_key: key.getPublicKey().toString() };
    });
    const signer = new SocketNearSigner(new SignerSocket(path), AGENT);
    const [hash, signed] = await transactions.signTransaction(
      VAULT, 5n, [transactions.functionCall("prepare", Buffer.from("{}"), 100_000_000_000_000n, 0n)], new Uint8Array(32), signer as never, AGENT, "testnet",
    );
    expect(seen.map((request) => request.op)).toEqual(["public_key", "sign_near_tx"]);
    expect(seen[1]!.agent).toBe(AGENT);
    expect(signed.transaction.receiverId).toBe(VAULT);
    expect(key.verify(hash, signed.signature.ed25519Signature!.data)).toBe(true);
  });

  it("turns a refusal into a SignerError with the signer's code", async () => {
    const path = fakeSigner(() => ({ ok: false, error: "RECEIVER_NOT_ALLOWED", detail: "usdc.fakes.testnet" }));
    const signer = new SocketNearSigner(new SignerSocket(path), AGENT);
    await expect(signer.signMessage(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ name: "SignerError", code: "RECEIVER_NOT_ALLOWED" });
    await expect(signer.signMessage(new Uint8Array([1]), "someone-else.testnet")).rejects.toThrow("serves");
    expect(new SignerError("X", "y").message).toContain("X");
  });

  it("forwards agent API calls through the signer, without any API key here", async () => {
    const seen: Record<string, unknown>[] = [];
    const path = fakeSigner((request) => {
      seen.push(request);
      return { ok: true, status: 200, body: { mandate: "payments" } };
    });
    const api = new SignerAgentApi(new SignerSocket(path), AGENT);
    expect(await api.mandate()).toEqual({ mandate: "payments" });
    await api.requestVisa([1, 2]);
    expect(seen).toEqual([
      { op: "api", agent: AGENT, method: "GET", path: "/v1/agent/mandate" },
      { op: "api", agent: AGENT, method: "POST", path: "/v1/operations/pay", body: { opId: [1, 2] } },
    ]);
  });

  it("says what to check when the signer is not there", async () => {
    const signer = new SocketNearSigner(new SignerSocket("/nonexistent/signer.sock"), AGENT);
    await expect(signer.getPublicKey()).rejects.toThrow("is euthyna-signer running?");
  });
});
