import { reserveStdoutForMcp } from "./stdio-logging.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  FileAgentKeyStore,
  HttpAgentApi,
  MandateAgentClient,
  NearVaultGateway,
  SignerAgentApi,
  SignerSocket,
  SocketNearSigner,
} from "@mandateos/sdk";

import { createMandateMcpServer, MandateMcpTools } from "./index.js";
reserveStdoutForMcp();

const env = z.object({
  /** euthyna-signer's socket: the key and the API key stay with the signer, this process holds no secret. */
  EUTHYNA_SIGNER_SOCKET: z.string().min(1).optional(),
  MANDATEOS_API_URL: z.string().url().default("http://localhost:3000"),
  MANDATEOS_AGENT_API_KEY: z.string().min(1).optional(),
  NEAR_NETWORK_ID: z.string().default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.near.org"),
  AGENT_NEAR_ACCOUNT_ID: z.string().min(2),
  AGENT_KEY_PATH: z.string().optional(),
  EUTHYNA_ALLOW_KEY_IN_PROJECT: z.literal("1").optional(),
  VAULT_ACCOUNT_ID: z.string().min(2),
  AGENT_ROLE: z.string().min(1),
  EVM_CHAIN_ID: z.coerce.number().int().positive().default(84532),
}).parse(process.env);

const common = {
  networkId: env.NEAR_NETWORK_ID,
  rpcUrl: env.NEAR_RPC_URL,
  accountId: env.AGENT_NEAR_ACCOUNT_ID,
  vaultAccountId: env.VAULT_ACCOUNT_ID,
  role: env.AGENT_ROLE,
  chainId: env.EVM_CHAIN_ID,
};

let client: MandateAgentClient;
if (env.EUTHYNA_SIGNER_SOCKET) {
  if (env.MANDATEOS_AGENT_API_KEY || env.AGENT_KEY_PATH) {
    console.error("euthyna: EUTHYNA_SIGNER_SOCKET is set; MANDATEOS_AGENT_API_KEY and AGENT_KEY_PATH are ignored. Remove them from this config.");
  }
  const socket = new SignerSocket(env.EUTHYNA_SIGNER_SOCKET);
  const vault = await NearVaultGateway.connect({ ...common, signer: new SocketNearSigner(socket, env.AGENT_NEAR_ACCOUNT_ID) });
  client = new MandateAgentClient(vault, new SignerAgentApi(socket, env.AGENT_NEAR_ACCOUNT_ID));
} else {
  // Local key mode: weaker, the AI's own user can read the file. Prefer euthyna-signer.
  if (!env.MANDATEOS_AGENT_API_KEY) throw new Error("set EUTHYNA_SIGNER_SOCKET (recommended) or MANDATEOS_AGENT_API_KEY");
  const keyPath = resolve(env.AGENT_KEY_PATH ?? defaultAgentKeyPath(env.AGENT_NEAR_ACCOUNT_ID));
  if (isInside(keyPath, process.cwd()) && !env.EUTHYNA_ALLOW_KEY_IN_PROJECT) {
    throw new Error(`the agent key ${keyPath} is inside the working directory, where the AI works: move it (default ${defaultAgentKeyPath(env.AGENT_NEAR_ACCOUNT_ID)}) or use euthyna-signer`);
  }
  console.error("euthyna: local key mode. The AI's user can read the key file; use euthyna-signer to keep it out of reach.");
  const key = await new FileAgentKeyStore(keyPath).loadOrCreate(env.NEAR_NETWORK_ID, env.AGENT_NEAR_ACCOUNT_ID);
  const vault = await NearVaultGateway.connect({ ...common, privateKey: key.privateKey });
  client = new MandateAgentClient(vault, new HttpAgentApi(env.MANDATEOS_API_URL, env.MANDATEOS_AGENT_API_KEY));
}
function defaultAgentKeyPath(accountId: string): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "euthyna", "keys", `${accountId}.json`);
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

const server = createMandateMcpServer(new MandateMcpTools(client));
await server.connect(new StdioServerTransport());
