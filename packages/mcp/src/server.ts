import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  FileAgentKeyStore,
  HttpAgentApi,
  MandateAgentClient,
  NearVaultGateway,
} from "@mandateos/sdk";

import { createMandateMcpServer, MandateMcpTools } from "./index.js";

const env = z.object({
  MANDATEOS_API_URL: z.string().url().default("http://localhost:3000"),
  MANDATEOS_AGENT_API_KEY: z.string().min(1),
  NEAR_NETWORK_ID: z.string().default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.near.org"),
  AGENT_NEAR_ACCOUNT_ID: z.string().min(2),
  AGENT_KEY_PATH: z.string().default(".mandateos/agent-key.json"),
  VAULT_ACCOUNT_ID: z.string().min(2),
}).parse(process.env);

const key = await new FileAgentKeyStore(env.AGENT_KEY_PATH).loadOrCreate(
  env.NEAR_NETWORK_ID,
  env.AGENT_NEAR_ACCOUNT_ID,
);
const vault = await NearVaultGateway.connect({
  networkId: env.NEAR_NETWORK_ID,
  rpcUrl: env.NEAR_RPC_URL,
  accountId: env.AGENT_NEAR_ACCOUNT_ID,
  privateKey: key.privateKey,
  vaultAccountId: env.VAULT_ACCOUNT_ID,
});
const client = new MandateAgentClient(
  vault,
  new HttpAgentApi(env.MANDATEOS_API_URL, env.MANDATEOS_AGENT_API_KEY),
);
const server = createMandateMcpServer(new MandateMcpTools(client));
await server.connect(new StdioServerTransport());
