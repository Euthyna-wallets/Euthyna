import { KeyPair } from "near-api-js";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";

const EVM_KEY = "mandateos.dev.evm.privateKey";
const NEAR_KEY = "mandateos.dev.near.secretKey";
const NEAR_ACCOUNT = "mandateos.dev.near.accountId";
let walletScope = "anonymous";

function scopedKey(base: string): string {
  return `${base}.${walletScope}`;
}

export function setDemoWalletScope(scope: string | null): void {
  walletScope = scope?.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
  if (!scope) return;
  for (const base of [EVM_KEY, NEAR_KEY, NEAR_ACCOUNT]) {
    const scoped = scopedKey(base);
    const anonymousKey = `${base}.anonymous`;
    const anonymous = localStorage.getItem(anonymousKey);
    if (anonymous !== null) {
      localStorage.setItem(scoped, anonymous);
      localStorage.removeItem(anonymousKey);
      continue;
    }
    const legacy = localStorage.getItem(base);
    if (localStorage.getItem(scoped) === null && legacy !== null) {
      localStorage.setItem(scoped, legacy);
      localStorage.removeItem(base);
    }
  }
}

export function demoWalletsEnabled(): boolean {
  return import.meta.env.VITE_UAT_DEMO_MODE === "1" || import.meta.env.VITE_E2E === "1";
}

export function selectDemoWalletScopeForAccounts(nearAccountId: string, evmAddress: string): boolean {
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(`${NEAR_KEY}.`)) continue;
    const scope = key.slice(NEAR_KEY.length + 1);
    const storedNear = localStorage.getItem(`${NEAR_ACCOUNT}.${scope}`);
    const evmKey = localStorage.getItem(`${EVM_KEY}.${scope}`) as Hex | null;
    if (
      storedNear === nearAccountId &&
      evmKey !== null &&
      privateKeyToAccount(evmKey).address.toLowerCase() === evmAddress.toLowerCase()
    ) {
      walletScope = scope;
      return true;
    }
  }
  return false;
}
export function selectDemoWalletScopeForEvmAddress(evmAddress: string): boolean {
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(`${EVM_KEY}.`)) continue;
    const evmKey = localStorage.getItem(key) as Hex | null;
    if (evmKey !== null && privateKeyToAccount(evmKey).address.toLowerCase() === evmAddress.toLowerCase()) {
      walletScope = key.slice(EVM_KEY.length + 1);
      return true;
    }
  }
  return false;
}


function requireDemoWallets(): void {
  if (!demoWalletsEnabled()) {
    throw new Error("browser-generated wallets are disabled outside explicit UAT demo mode");
  }
}

export function enforceWalletStoragePolicy(): void {
  if (!demoWalletsEnabled()) resetGeneratedWallets();
}

export interface GeneratedNearWallet {
  accountId: string;
  secretKey: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generatedEvmAccount(): PrivateKeyAccount {
  requireDemoWallets();
  const storageKey = scopedKey(EVM_KEY);
  let key = localStorage.getItem(storageKey) as Hex | null;
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(storageKey, key);
  }
  return privateKeyToAccount(key);
}

export function generatedNearWallet(): GeneratedNearWallet {
  requireDemoWallets();
  const secretStorageKey = scopedKey(NEAR_KEY);
  let secretKey = localStorage.getItem(secretStorageKey);
  if (!secretKey) {
    secretKey = KeyPair.fromRandom("ed25519").toString();
    localStorage.setItem(secretStorageKey, secretKey);
  }
  const keyPair = KeyPair.fromString(secretKey as `ed25519:${string}`);
  const accountId = localStorage.getItem(scopedKey(NEAR_ACCOUNT)) ?? bytesToHex(keyPair.getPublicKey().data);
  return { accountId, secretKey };
}

export function generatedNearPublicKey(): string {
  requireDemoWallets();
  const { secretKey } = generatedNearWallet();
  return KeyPair.fromString(secretKey as `ed25519:${string}`).getPublicKey().toString();
}

export function setGeneratedNearAccountId(accountId: string): void {
  requireDemoWallets();
  localStorage.setItem(scopedKey(NEAR_ACCOUNT), accountId);
}

export function resetGeneratedWallets(): void {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (
      key && [EVM_KEY, NEAR_KEY, NEAR_ACCOUNT].some((base) => key === base || key.startsWith(`${base}.`))
    ) {
      localStorage.removeItem(key);
    }
  }
}
