import { KeyPair } from "near-api-js";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";

const EVM_KEY = "mandateos.dev.evm.privateKey";
const NEAR_KEY = "mandateos.dev.near.secretKey";
const NEAR_ACCOUNT = "mandateos.dev.near.accountId";

export interface GeneratedNearWallet {
  accountId: string;
  secretKey: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generatedEvmAccount(): PrivateKeyAccount {
  let key = localStorage.getItem(EVM_KEY) as Hex | null;
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(EVM_KEY, key);
  }
  return privateKeyToAccount(key);
}

export function generatedNearWallet(): GeneratedNearWallet {
  let secretKey = localStorage.getItem(NEAR_KEY);
  if (!secretKey) {
    secretKey = KeyPair.fromRandom("ed25519").toString();
    localStorage.setItem(NEAR_KEY, secretKey);
  }
  const keyPair = KeyPair.fromString(secretKey as `ed25519:${string}`);
  const accountId = localStorage.getItem(NEAR_ACCOUNT) ?? bytesToHex(keyPair.getPublicKey().data);
  return { accountId, secretKey };
}

export function generatedNearPublicKey(): string {
  const { secretKey } = generatedNearWallet();
  return KeyPair.fromString(secretKey as `ed25519:${string}`).getPublicKey().toString();
}

export function setGeneratedNearAccountId(accountId: string): void {
  localStorage.setItem(NEAR_ACCOUNT, accountId);
}

export function resetGeneratedWallets(): void {
  localStorage.removeItem(EVM_KEY);
  localStorage.removeItem(NEAR_KEY);
  localStorage.removeItem(NEAR_ACCOUNT);
}
