import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { authClient } from "../auth.js";
import { demoWalletsEnabled } from "./wallet-store.js";
import {
  connectNearWallet,
  evmAccounts,
  evmConnectedAccounts,
  nearAccounts,
  nearSelector,
} from "../wallets.js";

interface RememberedWallets {
  nearAccountId: string;
  evmAddress: string;
}

interface WalletContextValue extends RememberedWallets {
  nearConnected: boolean;
  evmConnected: boolean;
  connecting: "near" | "evm" | null;
  connectNear: () => Promise<void>;
  connectEvm: () => Promise<void>;
  refresh: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

function storageKey(userId: string): string {
  return `mandateos.wallets.${userId}`;
}

function remembered(userId: string): RememberedWallets {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "{}") as Record<string, unknown>;
    return {
      nearAccountId: typeof value.nearAccountId === "string" ? value.nearAccountId : "",
      evmAddress: typeof value.evmAddress === "string" ? value.evmAddress : "",
    };
  } catch {
    return { nearAccountId: "", evmAddress: "" };
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  const userId = session.data?.user.id ?? "anonymous";
  const [wallets, setWallets] = useState<RememberedWallets>(() => remembered(userId));
  const [nearConnected, setNearConnected] = useState(false);
  const [evmConnected, setEvmConnected] = useState(false);
  const [connecting, setConnecting] = useState<"near" | "evm" | null>(null);

  const remember = (patch: Partial<RememberedWallets>) => {
    setWallets((current) => {
      const next = { ...current, ...patch };
      if (userId !== "anonymous") localStorage.setItem(storageKey(userId), JSON.stringify(next));
      return next;
    });
  };

  const refresh = async () => {
    const [near, evm] = await Promise.all([nearAccounts(), evmConnectedAccounts()]);
    const stored = remembered(userId);
    const nearAccountId = near[0] ?? stored.nearAccountId;
    const evmAddress = evm[0] ?? stored.evmAddress;
    setNearConnected(near.length > 0 && near[0] === nearAccountId);
    setEvmConnected(evm.length > 0 && evm[0]?.toLowerCase() === evmAddress.toLowerCase());
    remember({ nearAccountId, evmAddress });
  };

  useEffect(() => {
    setWallets(remembered(userId));
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(onFocus, 5_000);
    let unsubscribe: (() => void) | undefined;
    // Test and demo signers do not go through the wallet selector.
    const selectorDriven = import.meta.env.VITE_E2E !== "1" && !demoWalletsEnabled();
    if (selectorDriven) void nearSelector().then((selector) => {
      const subscription = selector.store.observable.subscribe((state) => {
        const accountId = state.accounts[0]?.accountId ?? "";
        setNearConnected(Boolean(accountId));
        if (accountId) remember({ nearAccountId: accountId });
      });
      unsubscribe = () => subscription.unsubscribe();
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
      unsubscribe?.();
    };
  }, [userId]);

  const connectNear = async () => {
    setConnecting("near");
    try {
      const current = await connectNearWallet();
      if (current[0]) remember({ nearAccountId: current[0] });
    } finally {
      setConnecting(null);
    }
  };

  const connectEvm = async () => {
    setConnecting("evm");
    try {
      const accounts = await evmAccounts();
      if (accounts[0]) {
        remember({ evmAddress: accounts[0] });
        setEvmConnected(true);
      }
    } finally {
      setConnecting(null);
    }
  };

  const value = useMemo<WalletContextValue>(() => ({
    ...wallets,
    nearConnected,
    evmConnected,
    connecting,
    connectNear,
    connectEvm,
    refresh,
  }), [wallets, nearConnected, evmConnected, connecting]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallets(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallets must be used inside WalletProvider");
  return value;
}
