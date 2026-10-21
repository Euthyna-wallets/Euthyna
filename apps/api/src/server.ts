import { serve } from "@hono/node-server";
import { Guard } from "./guard.js";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { NearClient } from "./near.js";
import { loadRegistry } from "./registry.js";
import { createBaseRelayer } from "./relayer.js";

const env = loadEnv();
const registry = await loadRegistry(env.VENDOR_REGISTRY_PATH);
const guardKey = Uint8Array.from(Buffer.from(env.GUARD_ED25519_PRIVATE_KEY_BASE64, "base64"));
const guard = new Guard(registry, guardKey);
const near = new NearClient(env);
const relayer = createBaseRelayer(env, near, guard);
const app = createApp(env, near, guard, relayer);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`MandateOS API listening on http://127.0.0.1:${info.port}`);
});
