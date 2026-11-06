import { reserveStdoutForMcp } from "./stdio-logging.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  FileAgentKeyStore,
  HttpAgentApi,
  SignerAgentApi,

  OnchainAgentClient,
  NearVaultGateway,

  MarketBuyer,
  nearRpc,
  SignerCard,
  SignerSocket,
  SocketNearSigner,
} from "@euthyna/sdk";

import { createMandateMcpServer, MandateMcpTools } from "./index.js";
import { SealedOrdersMcp } from "./sealed.js";
import { DEFAULT_SEALED_ACCOUNT, SealedAgent } from "@euthyna/sdk/sealed-agent";
reserveStdoutForMcp();

const env = z.object({
  /** euthyna-signer's socket: the key and the API key stay with the signer, this process holds no secret. Found by itself when installed. */
  EUTHYNA_SIGNER_SOCKET: z.string().min(1).optional(),
  /** The agent's NEAR account. With euthyna-signer, the rest (vault, role, network) is read from the signer. */
  EUTHYNA_AGENT: z.string().min(2).optional(),
  AGENT_NEAR_ACCOUNT_ID: z.string().min(2).optional(),
  MANDATEOS_API_URL: z.string().url().default("http://localhost:3000"),
  MANDATEOS_AGENT_API_KEY: z.string().min(1).optional(),
  NEAR_NETWORK_ID: z.string().optional(),
  NEAR_RPC_URL: z.string().url().optional(),
  AGENT_KEY_PATH: z.string().optional(),
  EUTHYNA_ALLOW_KEY_IN_PROJECT: z.literal("1").optional(),
  VAULT_ACCOUNT_ID: z.string().min(2).optional(),
  AGENT_ROLE: z.string().min(1).optional(),
  EVM_CHAIN_ID: z.coerce.number().int().positive().default(84532),
}).parse(process.env);

/** Where install.sh puts the socket, Linux first. */
const SIGNER_SOCKETS = ["/run/euthyna-signer/signer.sock", "/usr/local/var/run/euthyna-signer/signer.sock"];
const RPC_URLS: Record<string, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`set ${name}`);
  return value;
}

function settings(found: { accountId: string; vaultAccountId?: string | undefined; role?: string | undefined; networkId?: string | undefined }) {
  const networkId = env.NEAR_NETWORK_ID ?? found.networkId ?? "testnet";
  return {
    networkId,
    rpcUrl: env.NEAR_RPC_URL ?? RPC_URLS[networkId] ?? required(undefined, "NEAR_RPC_URL"),
    accountId: found.accountId,
    vaultAccountId: required(env.VAULT_ACCOUNT_ID ?? found.vaultAccountId, "VAULT_ACCOUNT_ID"),
    role: required(env.AGENT_ROLE ?? found.role, "AGENT_ROLE"),
    chainId: env.EVM_CHAIN_ID,
  };
}

const socketPath = env.EUTHYNA_SIGNER_SOCKET
  ?? (env.MANDATEOS_AGENT_API_KEY ? undefined : SIGNER_SOCKETS.find((path) => existsSync(path)));

const rpcUrl = process.env.EVM_RPC_URL ?? (env.EVM_CHAIN_ID === 84532 ? "https://sepolia.base.org" : "https://mainnet.base.org");
const { publicRpc } = await import("@euthyna/sdk");
let client: OnchainAgentClient;
let buyer: MarketBuyer | undefined;
let sealed: SealedOrdersMcp | undefined;

/** Sealed orders, on testnet by default; SEALED_ORDERS_ACCOUNT_ID="" turns them off. */
async function sealedFor(
  common: { networkId: string; rpcUrl: string; accountId: string; vaultAccountId: string; role: string },
  key: { privateKey: string } | { signer: InstanceType<typeof SocketNearSigner> },
): Promise<SealedOrdersMcp | undefined> {
  const sealedAccountId = process.env.SEALED_ORDERS_ACCOUNT_ID ?? (common.networkId === "testnet" ? DEFAULT_SEALED_ACCOUNT : "");
  if (!sealedAccountId) return undefined;
  const agent = await SealedAgent.connect({ networkId: common.networkId, nearRpc: common.rpcUrl, baseRpc: rpcUrl, sealedAccountId, accountId: common.accountId, ...key } as Parameters<typeof SealedAgent.connect>[0]);
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return new SealedOrdersMcp(agent, common.vaultAccountId, common.role, join(base, "euthyna", "sealed", common.accountId));
}
if (socketPath) {
  if (env.MANDATEOS_AGENT_API_KEY || env.AGENT_KEY_PATH) {
    console.error("euthyna: euthyna-signer is used; MANDATEOS_AGENT_API_KEY and AGENT_KEY_PATH are ignored. Remove them from this config.");
  }
  const socket = new SignerSocket(socketPath);
  let accountId = env.EUTHYNA_AGENT ?? env.AGENT_NEAR_ACCOUNT_ID;
  if (!accountId) {
    const status = await socket.call({ op: "status" });
    const agents = Array.isArray(status.agents) ? status.agents.map(String) : [];
    if (agents.length !== 1) {
      throw new Error(agents.length === 0
        ? "euthyna-signer holds no agent yet: hire one in the console and run the pair command it shows"
        : `euthyna-signer holds several agents (${agents.join(", ")}): set EUTHYNA_AGENT to one of them`);
    }
    accountId = agents[0]!;
  }
  const info = await socket.call({ op: "agent_info", agent: accountId });
  const common = settings({
    accountId,
    vaultAccountId: typeof info.vault === "string" ? info.vault : undefined,
    role: typeof info.role === "string" ? info.role : undefined,
    networkId: typeof info.network === "string" ? info.network : undefined,
  });
  const vault = await NearVaultGateway.connect({ ...common, signer: new SocketNearSigner(socket, accountId) });
  client = new OnchainAgentClient(vault, publicRpc(rpcUrl), new SignerAgentApi(socket, accountId));
  sealed = await sealedFor(common, { signer: new SocketNearSigner(socket, accountId) });
  // The market, when the agent has a spending card in the signer.
  const card = new SignerCard(socket, accountId);
  if (await card.info().then(() => true, () => false)) {
    buyer = new MarketBuyer(process.env.EUTHYNA_MARKET_URL ?? env.MANDATEOS_API_URL, card, nearRpc(common.rpcUrl));
  }
} else {
  // Local key mode: weaker, the AI's own user can read the file. Prefer euthyna-signer.

  const common = settings({ accountId: required(env.EUTHYNA_AGENT ?? env.AGENT_NEAR_ACCOUNT_ID, "EUTHYNA_AGENT") });
  const keyPath = resolve(env.AGENT_KEY_PATH ?? defaultAgentKeyPath(common.accountId));
  if (isInside(keyPath, process.cwd()) && !env.EUTHYNA_ALLOW_KEY_IN_PROJECT) {
    throw new Error(`the agent key ${keyPath} is inside the working directory, where the AI works: move it (default ${defaultAgentKeyPath(common.accountId)}) or use euthyna-signer`);
  }
  console.error("euthyna: local key mode. The AI's user can read the key file; use euthyna-signer to keep it out of reach.");
  const key = await new FileAgentKeyStore(keyPath).loadOrCreate(common.networkId, common.accountId);
  const vault = await NearVaultGateway.connect({ ...common, privateKey: key.privateKey });
  client = new OnchainAgentClient(vault, publicRpc(rpcUrl), env.MANDATEOS_AGENT_API_KEY ? new HttpAgentApi(env.MANDATEOS_API_URL, env.MANDATEOS_AGENT_API_KEY) : undefined);
  sealed = await sealedFor(common, { privateKey: key.privateKey });
}
function defaultAgentKeyPath(accountId: string): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "euthyna", "keys", `${accountId}.json`);
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

const server = createMandateMcpServer(new MandateMcpTools(client, buyer, sealed));
await server.connect(new StdioServerTransport());

