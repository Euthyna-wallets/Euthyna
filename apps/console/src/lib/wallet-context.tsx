import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { authClient } from "../auth.js";
import { demoWalletsEnabled } from "./wallet-store.js";
import { connectNearWallet, nearAccounts, nearSelector } from "../wallets.js";

/** The NEAR wallet a member signs votes, proposals and vetoes with. */
interface WalletContextValue {
  nearAccountId: string;
  nearConnected: boolean;
  connecting: boolean;
  connectNear: () => Promise<void>;
  refresh: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const storageKey = (userId: string) => `mandateos.wallets.${userId}`;

function remembered(userId: string): string {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "{}") as Record<string, unknown>;
    return typeof value.nearAccountId === "string" ? value.nearAccountId : "";
  } catch {
    return "";
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  const userId = session.data?.user.id ?? "anonymous";
  const [nearAccountId, setNearAccountId] = useState(() => remembered(userId));
  const [nearConnected, setNearConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const remember = (accountId: string) => {
    setNearAccountId(accountId);
    try {
      if (userId !== "anonymous") localStorage.setItem(storageKey(userId), JSON.stringify({ nearAccountId: accountId }));
    } catch {
      // Storage can be unavailable (private mode); the wallet is read again on focus.
    }
  };

  const refresh = async () => {
    const accounts = await nearAccounts().catch(() => []);
    const accountId = accounts[0] ?? remembered(userId);
    setNearConnected(accounts.length > 0);
    if (accountId) remember(accountId);
  };

  useEffect(() => {
    setNearAccountId(remembered(userId));
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(onFocus, 5_000);
    let unsubscribe: (() => void) | undefined;
    // Test and demo signers do not go through the wallet selector.
    if (import.meta.env.VITE_E2E !== "1" && !demoWalletsEnabled()) {
      void nearSelector().then((selector) => {
        const subscription = selector.store.observable.subscribe((state) => {
          const accountId = state.accounts[0]?.accountId ?? "";
          setNearConnected(Boolean(accountId));
          if (accountId) remember(accountId);
        });
        unsubscribe = () => subscription.unsubscribe();
      });
    }
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
      unsubscribe?.();
    };
  }, [userId]);

  const connectNear = async () => {
    setConnecting(true);
    try {
      const current = await connectNearWallet();
      if (current[0]) remember(current[0]);
    } finally {
      setConnecting(false);
    }
  };

  const value = useMemo<WalletContextValue>(
    () => ({ nearAccountId, nearConnected, connecting, connectNear, refresh }),
    [nearAccountId, nearConnected, connecting],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallets(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallets must be used inside WalletProvider");
  return value;
}
