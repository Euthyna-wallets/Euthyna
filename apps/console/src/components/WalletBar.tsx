import { short } from "./ui.js";
import { useWallets } from "../lib/wallet-context.js";

export function WalletBar() {
  const wallets = useWallets();
  return (
    <div className="wallet-bar" aria-label="Connected wallets">
      <div className={`wallet-identity ${wallets.nearConnected ? "connected" : ""}`}>
        <span className="wallet-network">NEAR</span>
        <strong>{wallets.nearAccountId ? short(wallets.nearAccountId, 10) : "Not connected"}</strong>
        <button className="ghost compact" disabled={wallets.connecting !== null} title={wallets.connecting ? "Wait for the current wallet connection" : "Connect or switch NEAR wallet"} onClick={() => void wallets.connectNear()}>
          {wallets.nearAccountId ? "Switch" : "Connect"}
        </button>
      </div>
      <div className={`wallet-identity ${wallets.evmConnected ? "connected" : ""}`}>
        <span className="wallet-network">BASE</span>
        <strong>{wallets.evmAddress ? short(wallets.evmAddress, 6) : "Not connected"}</strong>
        <button className="ghost compact" disabled={wallets.connecting !== null} title={wallets.connecting ? "Wait for the current wallet connection" : "Connect or switch Base wallet"} onClick={() => void wallets.connectEvm()}>
          {wallets.evmAddress ? "Switch" : "Connect"}
        </button>
      </div>
    </div>
  );
}
