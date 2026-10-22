import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadEnv } from "./env.js";
import { NearClient } from "./near.js";

const CONFIRMATION = "DEPLOY_MANDATEOS_DAO_FACTORY_TESTNET";

async function main(): Promise<void> {
  if (process.env.DAO_FACTORY_DEPLOY_CONFIRM !== CONFIRMATION) {
    throw new Error(`set DAO_FACTORY_DEPLOY_CONFIRM=${CONFIRMATION}`);
  }

  const env = loadEnv();
  if (env.NEAR_NETWORK_ID !== "testnet") throw new Error("DAO factory deploy script is testnet-only");
  const factoryId = `factory.${env.NEAR_ACCOUNT_PARENT}`;
  if (factoryId.length > 64) throw new Error(`factory account is too long: ${factoryId}`);

  const wasmPath = fileURLToPath(new URL("../../../contracts/res/dao_factory.wasm", import.meta.url));
  const codeBase64 = (await readFile(wasmPath)).toString("base64");
  const near = new NearClient(env);
  const txHash = await near.executeActions(factoryId, [
    { type: "CreateAccount" },
    { type: "Transfer", depositYocto: env.DAO_FACTORY_DEPOSIT_YOCTO },
    { type: "DeployContract", codeBase64 },
    {
      type: "FunctionCall",
      methodName: "new",
      args: {
        owner_id: env.NEAR_RELAYER_ACCOUNT_ID,
        dao_code_hash: env.DAO_GLOBAL_CODE_HASH,
      },
      gasTgas: 30,
    },
  ]);

  const accessKeys = await near.getAccessKeys(factoryId);
  if (accessKeys.keys.length !== 0) throw new Error("factory unexpectedly has an access key");
  const factoryHash = await near.viewFunction<string>(factoryId, "get_default_code_hash");
  if (factoryHash !== env.DAO_GLOBAL_CODE_HASH) throw new Error("factory global DAO hash mismatch");

  console.log(JSON.stringify({
    factoryId,
    txHash,
    accessKeyCount: accessKeys.keys.length,
    daoGlobalCodeHash: factoryHash,
    nextEnv: {
      DAO_FACTORY_ID: factoryId,
      DAO_CREATE_DEPOSIT_YOCTO: "250000000000000000000000",
    },
  }, null, 2));
}

await main();
