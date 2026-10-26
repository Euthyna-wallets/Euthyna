import { createConnection } from "node:net";

import { utils } from "near-api-js";

/**
 * Client for euthyna-signer: the daemon that holds the agent's key under
 * another system user. This process never sees the key; it sends the whole
 * unsigned transaction and gets a signature back, or a refusal.
 */
export class SignerError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`euthyna-signer refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "SignerError";
  }
}

const MAX_REPLY = 1024 * 1024;

export class SignerSocket {
  constructor(readonly path: string, readonly timeoutMs = 30_000) {}

  /** One request, one reply line. A refusal resolves; only transport failures reject. */
  request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.path);
      let buffer = "";
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(this.timeoutMs, () => fail(new Error(`euthyna-signer did not answer within ${this.timeoutMs} ms`)));
      socket.on("error", (error: NodeJS.ErrnoException) => {
        const hint = error.code === "ENOENT" ? " (is euthyna-signer running?)"
          : error.code === "EACCES" ? " (is this user in the signer's group?)" : "";
        fail(new Error(`cannot reach euthyna-signer at ${this.path}: ${error.message}${hint}`));
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > MAX_REPLY) return fail(new Error("euthyna-signer reply too large"));
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        socket.end();
        try {
          resolve(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
        } catch {
          reject(new Error("euthyna-signer sent an invalid reply"));
        }
      });
      socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    });
  }

  /** Like request, but a refusal throws SignerError. */
  async call(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.request(payload);
    if (reply.ok !== true) throw new SignerError(String(reply.error ?? "UNKNOWN"), String(reply.detail ?? ""));
    return reply;
  }
}

type NearPublicKey = ReturnType<typeof utils.PublicKey.fromString>;

/**
 * The two methods near-api-js 5 calls on a signer (Account → signTransaction →
 * signMessage with the Borsh-encoded transaction). Kept structural because the
 * workspace resolves several @near-js/signers versions.
 */
export interface AgentNearSigner {
  createKey(accountId: string): Promise<NearPublicKey>;
  getPublicKey(accountId?: string, networkId?: string): Promise<NearPublicKey>;
  signMessage(message: Uint8Array, accountId?: string, networkId?: string): Promise<{ signature: Uint8Array; publicKey: NearPublicKey }>;
}

/** A near-api-js signer whose key lives in euthyna-signer. */
export class SocketNearSigner implements AgentNearSigner {
  private publicKey: NearPublicKey | null = null;

  constructor(private readonly socket: SignerSocket, readonly accountId: string) {}

  async createKey(): Promise<NearPublicKey> {
    throw new Error("agent keys are created by the signer: `euthyna-signer pair` (the console gives the command)");
  }

  async getPublicKey(accountId?: string): Promise<NearPublicKey> {
    this.assertAccount(accountId);
    if (!this.publicKey) {
      const reply = await this.socket.call({ op: "public_key", agent: this.accountId });
      this.publicKey = utils.PublicKey.fromString(String(reply.public_key));
    }
    return this.publicKey;
  }

  /** near-api-js passes the Borsh-encoded transaction; the signer hashes and signs it. */
  async signMessage(message: Uint8Array, accountId?: string): Promise<{ signature: Uint8Array; publicKey: NearPublicKey }> {
    this.assertAccount(accountId);
    const reply = await this.socket.call({
      op: "sign_near_tx",
      agent: this.accountId,
      tx_borsh_b64: Buffer.from(message).toString("base64"),
    });
    const signature = utils.serialize.base_decode(String(reply.signature).replace(/^ed25519:/, ""));
    if (signature.length !== 64) throw new Error("euthyna-signer returned a malformed signature");
    const publicKey = utils.PublicKey.fromString(String(reply.public_key));
    this.publicKey = publicKey;
    return { signature: Uint8Array.from(signature), publicKey };
  }

  private assertAccount(accountId?: string) {
    if (accountId && accountId !== this.accountId) {
      throw new Error(`this signer serves ${this.accountId}, not ${accountId}`);
    }
  }
}
