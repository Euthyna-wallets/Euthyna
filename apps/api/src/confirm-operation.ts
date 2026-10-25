import { hexToBytes, type Hex } from "viem";
import { z } from "zod";
import { Guard } from "./guard.js";
import { EnvKmsSigner } from "./kms.js";
import { NearClient } from "./near.js";

const env = z.object({
  NEAR_NETWORK_ID: z.string().default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://test.rpc.fastnear.com"),
  NEAR_RELAYER_ACCOUNT_ID: z.string().min(1),
  NEAR_RELAYER_PRIVATE_KEY: z.string().min(1),
  GUARD_VISA_ED25519_PRIVATE_KEY_BASE64: z.string().min(1),
  GUARD_STATUS_ED25519_PRIVATE_KEY_BASE64: z.string().min(1),
  VAULT_ACCOUNT_ID: z.string().min(1),
  OP_ID_HEX: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex),
  BASE_TX_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex),
  BASE_BLOCK_NUMBER: z.coerce.bigint().positive(),
}).parse(process.env);

const near = new NearClient(env);
const guard = new Guard(
  new EnvKmsSigner(Uint8Array.from(Buffer.from(env.GUARD_VISA_ED25519_PRIVATE_KEY_BASE64, "base64"))),
  new EnvKmsSigner(Uint8Array.from(Buffer.from(env.GUARD_STATUS_ED25519_PRIVATE_KEY_BASE64, "base64"))),
);
const operation = await near.getOperation(
  env.VAULT_ACCOUNT_ID,
  Array.from(hexToBytes(env.OP_ID_HEX)),
);
const report = await guard.confirmationReport(
  operation,
  env.BASE_TX_HASH,
  env.BASE_BLOCK_NUMBER,
);
const nearTransactionHash = await near.reportStatus(env.VAULT_ACCOUNT_ID, report);
console.log(JSON.stringify({ nearTransactionHash, report }, null, 2));
