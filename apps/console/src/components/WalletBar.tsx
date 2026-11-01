import { useQuery } from "@tanstack/react-query";

import { displayAccount, short } from "./ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni } from "../omniroles-api.js";
import { switchNearWallet } from "../wallets.js";

/** Members sign votes with their NEAR wallet; it must be the account they signed in with. */
export function WalletBar() {
  const wallets = useWallets();
  const members = useQuery({ queryKey: ["omni-members"], queryFn: omni.members, staleTime: 60_000 });
  const me = members.data?.me ?? null;
  const mismatch = Boolean(me && wallets.nearAccountId && wallets.nearAccountId !== me);
  return (
    <div className="wallet-bar" aria-label="Signing wallet">
      {mismatch ? <span className="small warn">Wallet is {displayAccount(wallets.nearAccountId)}, you signed in as {displayAccount(me)}</span> : null}
      <div className={`wallet-identity ${wallets.nearConnected && !mismatch ? "connected" : ""}`}>
        <span className="wallet-network">NEAR</span>
        <strong className="mono">{wallets.nearAccountId ? short(wallets.nearAccountId, 14) : me ? short(me, 14) : "Not connected"}</strong>
        {mismatch ? (
          <button className="ghost compact" disabled={wallets.connecting} onClick={() => void switchNearWallet().then(() => wallets.refresh())}>
            Switch to {short(me ?? "", 10)}
          </button>
        ) : !wallets.nearConnected ? (
          <button className="ghost compact" disabled={wallets.connecting} onClick={() => void wallets.connectNear()}>
            Connect wallet
          </button>
        ) : null}
      </div>
    </div>
  );
}
