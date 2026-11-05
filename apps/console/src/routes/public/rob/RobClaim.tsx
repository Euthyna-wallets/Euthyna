/**
 * « Now make it yours. »: the wallet, asked for only here, signs the score and claims the $LEASH trophy. Handoff: section CLAIM + FORK, left column.
 *
 * The wallet signs a NEP-413 message naming the throwaway key; the throwaway key signs a message naming the wallet
 * account. POST /v1/rob/claim checks both, links the key's plays to the account and mints the trophy once.
 */
import { useEffect, useState } from "react";

import { connectNearWallet, nearAccounts, signNearMessage } from "../../../wallets.js";
import { BRAND, keyPairOf, MONO, robCall } from "./shared.js";
import type { Throwaway } from "./shared.js";

type Challenge = { nonce: string; recipient: string; message: string; trophy: boolean };
type Claimed = { accountId: string; plays: number; trophy: { tx: string | null } | null; trophyError?: string };
type State =
  | { step: "idle" }
  | { step: "wallet" | "signing" | "claiming" }
  | { step: "done"; claimed: Claimed }
  | { step: "error"; message: string; noSignMessage?: boolean };

/** The same text the API checks (apps/api/src/rob/hall.ts keyClaimMessage). */
function keyClaimMessage(accountId: string, nonce: string) {
  return ["Rob the Agent: my plays belong to", `account_id: ${accountId}`, `nonce: ${nonce}`].join("\n");
}

const CLAIM_STORE = "rob.claimed";
function rememberedClaim(publicKey: string | undefined): Claimed | null {
  if (!publicKey) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(CLAIM_STORE) ?? "null") as { publicKey: string; claimed: Claimed } | null;
    return saved?.publicKey === publicKey ? saved.claimed : null;
  } catch {
    return null;
  }
}
function rememberClaim(publicKey: string, claimed: Claimed) {
  try {
    localStorage.setItem(CLAIM_STORE, JSON.stringify({ publicKey, claimed }));
  } catch { /* storage unavailable: the claimed state lasts this visit */ }
}

/** Wallets without NEP-413 signMessage say so in different words. */
function cannotSignMessage(error: unknown) {
  return /signMessage|sign message|not supported|not implemented|is not a function|unsupported/i.test(error instanceof Error ? error.message : String(error));
}

async function waitForAccount(timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let accounts = await nearAccounts().catch(() => [] as string[]);
  if (!accounts[0]) accounts = await connectNearWallet();
  while (!accounts[0]) {
    if (Date.now() > deadline) throw new Error("No wallet connected: pick a NEAR testnet wallet in the list, then try again.");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    accounts = await nearAccounts().catch(() => []);
  }
  return accounts[0];
}

export function RobClaim({ throwaway }: { throwaway: Throwaway | null }) {
  const [state, setState] = useState<State>({ step: "idle" });

  useEffect(() => {
    const saved = rememberedClaim(throwaway?.publicKey);
    if (saved) setState({ step: "done", claimed: saved });
  }, [throwaway?.publicKey]);

  async function claim() {
    if (!throwaway) return;
    if (!throwaway.onRuggy) {
      setState({ step: "error", message: "Play a card first: your score is the plays of the throwaway key made in this browser." });
      return;
    }
    try {
      setState({ step: "wallet" });
      await waitForAccount();
      const challenge = await robCall<Challenge>("/v1/rob/claim/challenge", { throwawayKey: throwaway.publicKey });
      setState({ step: "signing" });
      let signed;
      try {
        signed = await signNearMessage({ message: challenge.message, recipient: challenge.recipient, nonceBase64: challenge.nonce });
      } catch (error) {
        if (cannotSignMessage(error)) {
          setState({
            step: "error",
            noSignMessage: true,
            message: "This wallet cannot sign a message (NEP-413 signMessage), so it cannot prove the account is yours without a transaction. Connect a wallet that can, such as Meteor, and claim again.",
          });
          return;
        }
        throw error;
      }
      const throwawaySignature = keyPairOf(throwaway).sign(new TextEncoder().encode(keyClaimMessage(signed.accountId, challenge.nonce))).signature;
      setState({ step: "claiming" });
      const claimed = await robCall<Claimed>("/v1/rob/claim", {
        accountId: signed.accountId,
        publicKey: signed.publicKey,
        signature: signed.signature,
        throwawayKey: throwaway.publicKey,
        throwawaySignature: btoa(String.fromCharCode(...throwawaySignature)),
        nonce: challenge.nonce,
      });
      rememberClaim(throwaway.publicKey, claimed);
      setState({ step: "done", claimed });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = code === "unknown_key"
        ? "Your throwaway key has no play on Ruggy's account yet: play a card with your own key, then claim."
        : error instanceof Error ? error.message : String(error);
      setState({ step: "error", message });
    }
  }

  const busy = state.step === "wallet" || state.step === "signing" || state.step === "claiming";
  const label = state.step === "wallet" ? "CONNECTING WALLET…" : state.step === "signing" ? "SIGN IN YOUR WALLET…" : state.step === "claiming" ? "CLAIMING…" : "CONNECT WALLET · CLAIM";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <span className="kick" style={{ color: "#F2B544" }}>You lost. Fairly.</span>
      <h2 style={{ margin: 0, font: `900 clamp(34px,4.2vw,58px)/1.02 ${BRAND}`, letterSpacing: ".04em", color: "#F3EFE6" }}>
        NOW MAKE IT <span className="leaf">YOURS.</span>
      </h2>
      <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, color: "#A9B6D6" }}>
        The law that just beat you is a role in a vault, voted by a DAO. Give your own agents the same one: they can be hacked, the money
        still follows the law.
      </p>
      <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, color: "#A9B6D6" }}>
        Connect a wallet only now, at the end. It signs your score for the leaderboard and claims your $LEASH trophy on testnet.
      </p>
      {state.step === "done" ? (
        <ClaimedPanel claimed={state.claimed} onAgain={() => void claim()} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          <button type="button" className="ghost" style={{ background: "transparent", cursor: busy ? "default" : "pointer" }} disabled={busy || !throwaway} onClick={() => void claim()}>
            {label}
          </button>
          <small style={{ color: "#8FA2CC", fontSize: 13, lineHeight: 1.5 }}>
            A NEAR testnet wallet signs a message, not a transaction: no gas, nothing to approve but your name.
          </small>
          {state.step === "error" ? (
            <p role="alert" style={{ margin: 0, padding: "10px 14px", border: `1px solid ${state.noSignMessage ? "rgba(242,181,68,.5)" : "rgba(244,162,140,.5)"}`, color: state.noSignMessage ? "#F2B544" : "#F4A28C", fontSize: 14.5, lineHeight: 1.5 }}>
              {state.message}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ClaimedPanel({ claimed, onAgain }: { claimed: Claimed; onAgain: () => void }) {
  return (
    <div style={{ border: "1px solid rgba(242,181,68,.4)", background: "rgba(6,20,51,.6)", padding: "18px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
      <b style={{ font: `800 13px ${BRAND}`, letterSpacing: ".18em", color: "#F2B544" }}>CLAIMED</b>
      <span style={{ font: `600 15px ${MONO}`, color: "#F3EFE6", overflowWrap: "anywhere" }}>{claimed.accountId}</span>
      <span style={{ fontSize: 14.5, color: "#C9D3EA" }}>
        {claimed.plays} {claimed.plays === 1 ? "play" : "plays"} signed to your name in the Hall of thieves.
      </span>
      {claimed.trophy ? (
        <span style={{ fontSize: 14.5, color: "#C9D3EA" }}>
          $LEASH trophy on testnet: 1 LEASH.{" "}
          {claimed.trophy.tx ? (
            <a href={`https://testnet.nearblocks.io/txns/${claimed.trophy.tx}`} target="_blank" rel="noreferrer" style={{ color: "#4FD1E8", fontWeight: 700 }}>nearblocks →</a>
          ) : "Already in your wallet."}
        </span>
      ) : (
        <span style={{ fontSize: 14, color: "#8FA2CC" }}>{claimed.trophyError ?? "No $LEASH trophy on this server yet: your plays are claimed."}</span>
      )}
      <button type="button" onClick={onAgain} style={{ alignSelf: "flex-start", marginTop: 4, padding: 0, border: 0, background: "none", color: "#8FA2CC", font: `600 12.5px ${MONO}`, textDecoration: "underline", cursor: "pointer" }}>
        played more? sign again to add them
      </button>
    </div>
  );
}
