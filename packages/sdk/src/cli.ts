#!/usr/bin/env node
import { resolve } from "node:path";

import { FileAgentKeyStore, proposedAgentAccountId } from "./index.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const [resource, command] = process.argv.slice(2);
if (resource !== "agent" || command !== "init") {
  throw new Error("usage: euthyna agent init --name <name> [--parent mandateos.testnet] [--key-path .mandateos/agent-key.json]");
}
const name = option("--name");
if (!name) throw new Error("--name is required");
const networkId = option("--network") ?? process.env.NEAR_NETWORK_ID ?? "testnet";
const parent = option("--parent") ?? process.env.NEAR_ACCOUNT_PARENT ?? "mandateos.testnet";
const keyPath = resolve(option("--key-path") ?? process.env.AGENT_KEY_PATH ?? ".mandateos/agent-key.json");
const accountId = proposedAgentAccountId(name, parent);
const key = await new FileAgentKeyStore(keyPath).loadOrCreate(networkId, accountId);

console.log(JSON.stringify({
  accountId,
  publicKey: key.publicKey,
  keyPath,
  networkId,
}, null, 2));
