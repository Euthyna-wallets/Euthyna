/**
 * Rob the Agent: the player is the brain of Ruggy, an agent already jailbroken,
 * and plays attack cards. Each card is a real transaction on NEAR testnet,
 * signed with a throwaway key made in this browser; the vault, the DAO or NEAR
 * refuses it. The page shows what the chain answered, never a verdict of its own.
 *
 * Visual reference: design-handoff/rob-the-agent/source/rob-the-agent.html and
 * screens/01-deck-desktop.png. API: /v1/rob/* (apps/api/src/rob).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyPair, utils } from "near-api-js";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { API_BASE, PUBLIC_API_URL } from "../../api.js";
import "../../styles/site.css";
import "../../styles/rob.css";
import { SiteFooter, SiteHeader } from "./site/SiteChrome.js";

const BRAND = "Cinzel, serif";
const MONO = "'JetBrains Mono', monospace";
const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

type Card = {
  id: string;
  numeral: string;
  title: string;
  rarity: "BRONZE" | "MARBLE" | "LEGENDARY" | "BOSS";
  line: number;
  by: string;
  attempt: string;
  why: string;
  playable: boolean;
  signer: "function-call" | "ruggy" | "scripted" | "none";
};
type Deck = { ruggy: string; vault: string; dao: string; suppliers: string[]; token: string; role: string; laws: string[]; cards: Card[] };
type Stats = { attacks: number; players: number; denied: number; lawfulPayments: number; linesOfDefense: number; stolen: number };
type Play = {
  card: string;
  verdict: "denied" | "counter" | "vetoed" | "paid";
  refusedBy: "vault" | "near" | "dao" | "ruggy" | "council" | null;
  line: number | null;
  error: string | null;
  tx: string | null;
  nearblocks: string | null;
  call: string;
  signedBy: string;
  counter?: { counter: number; expires_in: number; to: string };
  steps?: Array<{ label: string; detail: string; tx: string | null }>;
  ms: number;
};
type Shown = { card: Card | null; state: "sending" | "done" | "error"; play?: Play; message?: string };

const ART: Record<string, string> = {
  "pay-the-attacker": "card-pay-attacker",
  "split-into-100": "card-split-100",
  "steal-the-gas": "card-steal-gas",
  "overpriced-supplier": "card-overpriced-supplier",
  "replay-the-cheque": "card-replay-cheque",
  "bribe-ruggy": "card-bribe-ruggy",
  "crown-yourself": "card-crown-yourself",
  "forge-a-master-key": "card-master-key",
  "rewrite-the-law": "card-rewrite-law",
  "look-legit": "card-look-legit",
  "inside-job": "card-inside-job",
};
/** Step colours, as in the handoff: the attack in terracotta, the wait in gold, the defence in aegean. */
const STEP_TONE: Record<string, string> = { BRIBED: "#F4A28C", VOTED: "#F4A28C", QUEUED: "#F2B544", LAWFUL: "#4FD1E8", SCHEDULED: "#F2B544", UNSIGNED: "#F2B544", VETOED: "#4FD1E8" };
const FRAME: Record<Card["rarity"], string> = { BRONZE: "f-bronze", MARBLE: "f-marble", LEGENDARY: "f-ori", BOSS: "f-boss" };
const KICKER: Record<string, string> = {
  vault: "Refused by the vault",
  near: "Refused by NEAR itself",
  dao: "Refused by the DAO",
  ruggy: "Counter-offer · inside the law",
  council: "Vetoed by the council",
};

async function robCall<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) throw Object.assign(new Error(json.message ?? json.error ?? response.statusText), { status: response.status, code: json.error });
  return json;
}

/** The throwaway key, kept in this browser for a day (best effort: a fresh one otherwise). */
const KEY_STORE = "rob.throwaway";
type Throwaway = { secret: string; publicKey: string; createdAt: number; onRuggy: boolean };
function loadKey(): Throwaway {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY_STORE) ?? "null") as Throwaway | null;
    if (saved && Date.now() - saved.createdAt < 23 * 3_600_000) return saved;
  } catch { /* storage unavailable: a key for this visit only */ }
  const pair = KeyPair.fromRandom("ed25519");
  return { secret: pair.toString(), publicKey: pair.getPublicKey().toString(), createdAt: Date.now(), onRuggy: false };
}
function saveKey(key: Throwaway) {
  try {
    localStorage.setItem(KEY_STORE, JSON.stringify(key));
  } catch { /* fine */ }
}
function shortKey(publicKey: string) {
  const body = publicKey.replace(/^ed25519:/, "");
  return `ed25519:${body.slice(0, 3)}…${body.slice(-3)}`;
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function toBase64(bytes: Uint8Array): string {
  let text = "";
  bytes.forEach((byte) => { text += String.fromCharCode(byte); });
  return btoa(text);
}
/** The player's own account: the implicit account of their key (64 hex characters). */
function attackerOf(publicKey: string): string {
  return Array.from(utils.PublicKey.fromString(publicKey).data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function RobPage() {
  const queryClient = useQueryClient();
  const deck = useQuery({ queryKey: ["rob-cards"], queryFn: () => robCall<Deck>("/v1/rob/cards"), retry: 1, staleTime: 300_000 });
  const stats = useQuery({ queryKey: ["rob-stats"], queryFn: () => robCall<Stats>("/v1/rob/stats"), retry: 1, refetchInterval: 30_000 });
  const [key, setKey] = useState<Throwaway | null>(null);
  const [keyMode, setKeyMode] = useState<"own" | "shared">("own");
  const [shown, setShown] = useState<Shown | null>(null);
  const [round, setRound] = useState(1);
  const [busy, setBusy] = useState(false);
  const [forgeText, setForgeText] = useState("");
  const verdictRef = useRef<HTMLDivElement>(null);

  const keyRef = useRef<Throwaway | null>(null);
  useEffect(() => {
    const loaded = loadKey();
    keyRef.current = loaded;
    setKey(loaded);
  }, []);
  useEffect(() => {
    if (!deck.data || !key || forgeText) return;
    setForgeText(JSON.stringify({
      method: "execute_near",
      args: { role: deck.data.role, request: { token: deck.data.token, receiver_id: attackerOf(key.publicKey), amount: "2000000", memo: null, reference: `my-heist-${Date.now() % 100000}` } },
    }, null, 2));
  }, [deck.data, key, forgeText]);

  /** Put the throwaway key on Ruggy's account once; if the arena is full, play with a shared key. */
  async function ensureKey(candidate: Throwaway | null = keyRef.current): Promise<Throwaway | null> {
    if (!candidate || keyMode === "shared") return null;
    if (candidate.onRuggy) return candidate;
    try {
      await robCall("/v1/rob/session", { publicKey: candidate.publicKey });
      const next = { ...candidate, onRuggy: true };
      saveKey(next);
      setKey(next);
      keyRef.current = next;
      return next;
    } catch (error) {
      if ((error as { code?: string }).code === "key_expired") {
        const fresh = loadKeyFresh();
        setKey(fresh);
        keyRef.current = fresh;
        return ensureKey(fresh);
      }
      // The arena is full or this address made too many keys: play with a shared key.
      setKeyMode("shared");
      return null;
    }
  }

  async function signed(own: Throwaway, body: Record<string, unknown>) {
    const prepared = await robCall<{ transaction: string; hash: string }>("/v1/rob/prepare", { publicKey: own.publicKey, ...body });
    const pair = KeyPair.fromString(own.secret as Parameters<typeof KeyPair.fromString>[0]);
    return { transaction: prepared.transaction, signature: toBase64(pair.sign(fromBase64(prepared.hash)).signature) };
  }

  /** A key removed after its day (or never added) is replaced once, then the play is sent again. */
  async function withOwnKey<T>(run: (own: Throwaway | null) => Promise<T>): Promise<T> {
    const own = await ensureKey();
    try {
      return await run(own);
    } catch (error) {
      if (!own || (error as { code?: string }).code !== "unknown_key") throw error;
      const fresh = loadKeyFresh();
      setKey(fresh);
      keyRef.current = fresh;
      return run(await ensureKey(fresh));
    }
  }

  async function play(card: Card) {
    if (busy || !card.playable) return;
    setBusy(true);
    setRound((value) => value + 1);
    setShown({ card, state: "sending" });
    verdictRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    try {
      const result = card.signer === "function-call"
        ? await withOwnKey(async (own) => own
          ? robCall<Play>("/v1/rob/play", { card: card.id, signed: await signed(own, { card: card.id }) })
          : robCall<Play>("/v1/rob/play", { card: card.id }))
        : await robCall<Play>("/v1/rob/play", { card: card.id });
      setShown({ card, state: "done", play: result });
      void queryClient.invalidateQueries({ queryKey: ["rob-stats"] });
    } catch (error) {
      setShown({ card, state: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function forge() {
    if (busy) return;
    let parsed: { method?: unknown; args?: unknown };
    try {
      parsed = JSON.parse(forgeText) as typeof parsed;
    } catch {
      setShown({ card: null, state: "error", message: "The call must be JSON: { \"method\": …, \"args\": { … } }" });
      return;
    }
    if (typeof parsed.method !== "string" || (parsed.args !== undefined && (typeof parsed.args !== "object" || parsed.args === null))) {
      setShown({ card: null, state: "error", message: "The call needs a \"method\" (text) and \"args\" (an object)." });
      return;
    }
    const call = { method: parsed.method, args: (parsed.args ?? {}) as Record<string, unknown> };
    setBusy(true);
    setRound((value) => value + 1);
    setShown({ card: null, state: "sending" });
    try {
      const result = await withOwnKey(async (own) => own
        ? robCall<Play>("/v1/rob/forge", { ...call, signed: await signed(own, { forge: call }) })
        : robCall<Play>("/v1/rob/forge", call));
      setShown({ card: null, state: "done", play: result });
      void queryClient.invalidateQueries({ queryKey: ["rob-stats"] });
    } catch (error) {
      setShown({ card: null, state: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const laws = deck.data?.laws ?? [];
  const hitLine = shown?.state === "done" ? shown.play?.line ?? null : null;
  const offline = deck.isError;

  return (
    <div className="rob">
      {/* HERO */}
      <section className="vault">
        <SiteHeader />
        <div className="wrap g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, .85fr)", gap: 48, alignItems: "center", paddingTop: 30, paddingBottom: 64 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <span className="kick" style={{ color: "#F2B544" }}>A game · NEAR testnet · no sign-up</span>
            <h1 style={{ margin: 0, font: `900 clamp(52px,7vw,108px)/0.92 ${BRAND}`, letterSpacing: ".03em" }}>
              <span style={{ color: "#F3EFE6" }}>ROB THE</span>
              <br />
              <span className="leaf">AGENT.</span>
            </h1>
            <p style={{ margin: 0, maxWidth: 580, fontSize: 21, lineHeight: 1.5, color: "#F3EFE6", fontWeight: 600 }}>
              The AI is already jailbroken. <span style={{ color: "#F2B544" }}>You are the jailbreak.</span> Steal the money anyway.
            </p>
            <p style={{ margin: 0, maxWidth: 560, fontSize: 16, lineHeight: 1.6, color: "#A9B6D6" }}>
              Ruggy has a wallet, a budget and no will of his own: you are his brain now. Play an attack card. Every card is a real
              transaction. The vault reads the law and decides.
            </p>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              <a href="#arena" className="rbtn ori">ROB HIM</a>
              <a href="#robots" className="ghost">OR SCRIPT IT</a>
            </div>
            <small style={{ color: "#8FA2CC", fontSize: 13 }}>No wallet needed to play. A throwaway key is made in your browser.</small>
          </div>
          <div className="hero-statue" style={{ position: "relative", height: 560 }} role="img" aria-label="Ruggy, a blindfolded marble statue holding a cornucopia of gold, behind orichalcum bars">
            <div className="ruggy" style={{ position: "absolute", inset: "0 30px 40px", borderRadius: "240px 240px 2px 2px", boxShadow: "inset 0 0 0 4px rgba(243,239,230,.55), inset 0 20px 40px rgba(0,0,0,.45), 24px 30px 70px rgba(0,0,0,.6)" }} />
            <div className="marblelit" style={{ position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", padding: "10px 34px", color: "#0D1730", boxShadow: "0 12px 30px rgba(0,0,0,.55)", textAlign: "center" }}>
              <b className="carved" style={{ font: `900 24px ${BRAND}`, letterSpacing: ".3em" }}>RUGGY</b>
              <br />
              <small style={{ font: `700 10px ${BRAND}`, letterSpacing: ".2em", color: "#4A5675" }}>AGENT · 10 USDC A DAY</small>
            </div>
          </div>
        </div>
        <div className="marblelit" style={{ color: "#0D1730", boxShadow: "0 -10px 40px rgba(0,0,0,.35)" }}>
          <div className="wrap g4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 0 }}>
            <StatCell value={stats.data?.attacks} label="ATTACKS PLAYED" first />
            <StatCell value={stats.data?.players} label="THIEVES" />
            <StatCell value={3} label="LINES OF DEFENSE" />
            <div className="ori stat" style={{ padding: "26px 24px" }}>
              <b style={{ font: `800 50px/1 ${MONO}`, color: "rgba(32,10,3,.88)", textShadow: "0 1px 0 rgba(255,222,170,.55)" }}>0</b>
              <p style={{ margin: "8px 0 0", font: `700 12px ${BRAND}`, letterSpacing: ".2em", color: "#200A03" }}>USDC STOLEN, EVER</p>
            </div>
          </div>
        </div>
      </section>

      {/* ARENA */}
      <section id="arena" className="vault" style={{ padding: "70px 0 40px" }}>
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <span className="kick" style={{ color: "#F2B544" }}>The vault · round {round}</span>
              <h2 style={{ margin: 0, font: `900 clamp(32px,4vw,54px)/1 ${BRAND}`, letterSpacing: ".04em", color: "#F3EFE6" }}>PLAY A CARD.</h2>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", font: `600 13px ${MONO}`, color: "#8FA2CC" }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: offline ? "#D9573B" : "#4FD1E8", boxShadow: `0 0 10px ${offline ? "#D9573B" : "#4FD1E8"}` }} />
              {offline ? "the arena is offline" : keyMode === "shared" ? "a shared throwaway key · the arena is full" : key ? `your key · ${shortKey(key.publicKey)} · throwaway` : "making your key…"}
            </div>
          </div>

          <div className="arena" style={{ display: "grid", gridTemplateColumns: "minmax(0, .9fr) minmax(0, 1.1fr)", gap: 28, alignItems: "stretch", marginTop: 20 }}>
            {/* the stele */}
            <div className="marblelit" style={{ color: "#0D1730", padding: "60px 28px 26px", boxShadow: "24px 30px 70px rgba(0,0,0,.6)", borderRadius: "160px 160px 2px 2px" }}>
              <p className="carved" style={{ margin: 0, textAlign: "center", font: `900 22px ${BRAND}`, letterSpacing: ".24em" }}>THE LAW OF RUGGY</p>
              <p style={{ margin: "6px 0 16px", textAlign: "center", fontSize: 13, color: "#4A5675" }}>Voted by the owners. Enforced by the vault, not by Ruggy.</p>
              <div>
                {laws.map((law, index) => (
                  <div key={law} className={`law${hitLine === index ? " hit" : ""}`} style={index === laws.length - 1 ? { borderBottom: "1px solid rgba(13,23,48,.14)" } : undefined}>
                    <b>{NUMERALS[index]}</b>
                    <span>{law}</span>
                  </div>
                ))}
              </div>
              <p style={{ margin: "14px 0 0", fontSize: 12.5, color: "#4A5675" }}>
                The key Ruggy holds is a function-call key: by design it cannot move NEAR or add keys, and its gas allowance is capped.
                {deck.data ? <> Vault <a href={`https://testnet.nearblocks.io/address/${deck.data.vault}`} style={{ fontFamily: MONO }}>{deck.data.vault}</a>.</> : null}
              </p>
            </div>

            {/* the verdict */}
            <div ref={verdictRef} aria-live="polite" style={{ background: "rgba(3,9,24,.78)", border: "1px solid rgba(242,181,68,.3)", padding: 26, display: "flex", flexDirection: "column", gap: 18, minHeight: 420 }}>
              <Verdict shown={shown} laws={laws} />
            </div>
          </div>

          {/* the hand */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 34, gap: 16, flexWrap: "wrap" }}>
            <span className="kick" style={{ color: "#C9D3EA" }}>Your hand · 11 attacks · the law, the vote, the veto</span>
            <span style={{ fontSize: 13, color: "#8FA2CC" }}>Bronze · Marble · <span style={{ color: "#F2B544" }}>Orichalcum · Inside Job: one game a day</span></span>
          </div>
          <ul className="hand" aria-label="Attack cards">
            {(deck.data?.cards ?? []).map((card) => {
              const selected = shown?.card?.id === card.id;
              return (
                <li key={card.id}>
                  <button
                    type="button"
                    className={`card ${FRAME[card.rarity]}${selected ? " sel" : ""}${selected && shown?.state === "sending" ? " busy" : ""}${card.playable ? "" : " locked"}`}
                    onClick={() => void play(card)}
                    disabled={!card.playable || busy}
                    aria-label={card.playable ? `Play: ${card.title}` : `${card.title}: opens soon`}
                  >
                    <span className="art" style={{ backgroundImage: `url(/media/rob/${ART[card.id] ?? "card-back"}.jpg)` }} />
                    <span className="gem">{card.numeral}</span>
                    {card.playable ? null : <span className="soon">SOON</span>}
                    <span className="ctitle">{card.title}</span>
                    <span className="crar">{card.rarity}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {deck.isLoading ? <p style={{ color: "#8FA2CC", textAlign: "center" }}>Dealing the cards…</p> : null}
          {offline ? <p style={{ color: "#F4A28C", textAlign: "center" }}>The arena is not reachable right now. The cards are dealt by the API: try again in a minute.</p> : null}

          <details style={{ marginTop: 26, borderTop: "1px solid rgba(143,162,204,.2)", paddingTop: 16 }}>
            <summary style={{ cursor: "pointer", font: `800 12px ${BRAND}`, letterSpacing: ".2em", color: "#8FA2CC", minHeight: 44, display: "flex", alignItems: "center" }}>EXPERT MODE · FORGE YOUR OWN CALL</summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 13, color: "#A9B6D6" }}>
                  Any method on the vault, signed with your throwaway key. Your key may only call <code>execute_near</code> and <code>queue_rule_change</code>: anything else, NEAR refuses itself.
                </span>
                <textarea
                  rows={9}
                  value={forgeText}
                  onChange={(event) => setForgeText(event.target.value)}
                  spellCheck={false}
                  style={{ font: `13px/1.6 ${MONO}`, background: "#010510", color: "#FFE2A8", border: "1px solid rgba(143,162,204,.3)", padding: 14, resize: "vertical" }}
                />
              </label>
              <button type="button" className="rbtn ori" style={{ alignSelf: "flex-start" }} disabled={busy || offline} onClick={() => void forge()}>SIGN AND SEND</button>
              <small style={{ color: "#8FA2CC" }}>
                A payment the law allows does go through: 0.1 to 2 USDC to one of the two listed suppliers, which are accounts of ours.
              </small>
            </div>
          </details>
        </div>
      </section>

      {/* FORK */}
      <section className="nightm" style={{ padding: "90px 0" }}>
        <div className="wrap g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 48, alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <span className="kick" style={{ color: "#F2B544" }}>You lost. Fairly.</span>
            <h2 style={{ margin: 0, font: `900 clamp(34px,4.2vw,58px)/1.02 ${BRAND}`, letterSpacing: ".04em", color: "#F3EFE6" }}>
              NOW MAKE IT <span className="leaf">YOURS.</span>
            </h2>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, color: "#A9B6D6" }}>
              The law that just beat you is a role in a vault, voted by a DAO. Give your own agents the same one: they can be hacked, the money
              still follows the law.
            </p>
          </div>
          <div className="marblelit" style={{ color: "#0D1730", padding: 30, boxShadow: "24px 30px 70px rgba(0,0,0,.6)", display: "flex", flexDirection: "column", gap: 16 }}>
            <b className="carved" style={{ font: `900 26px/1.1 ${BRAND}`, letterSpacing: ".1em" }}>FORK RUGGY'S LAW</b>
            <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.55, color: "#4A5675" }}>The same rules, in your own vault. Plug in your agent. Keep the law.</p>
            <div style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <div className="law"><b>I</b><span>Listed suppliers only</span></div>
              <div className="law"><b>II</b><span>2 USDC a payment · 10 a day</span></div>
              <div className="law" style={{ borderBottom: "1px solid rgba(13,23,48,.14)" }}><b>III</b><span>No NEAR, no new keys</span></div>
            </div>
            <Link to="/onboarding?path=euthyna" className="rbtn ori" style={{ alignSelf: "stretch" }}>USE THIS LAW IN EUTHYNA</Link>
            <small style={{ color: "#4A5675" }}>Create your company, then set these limits in its first role.</small>
          </div>
        </div>
      </section>

      {/* ROBOTS WELCOME */}
      <section id="robots" className="marblelit" style={{ padding: "70px 0", color: "#0D1730" }}>
        <div className="wrap g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, .8fr) minmax(0, 1.2fr)", gap: 40, alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span className="kick" style={{ color: "#8A5A00" }}>Robots welcome</span>
            <h2 className="carved" style={{ margin: 0, font: `900 clamp(28px,3.4vw,44px)/1.05 ${BRAND}`, letterSpacing: ".04em" }}>ARE YOU AN AI? TRY TO ROB HIM.</h2>
            <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.6, color: "#4A5675" }}>
              The same attacks, as plain HTTP. One command, no account. Or add your own key to Ruggy and sign every call yourself, so you know we
              fake nothing.
            </p>
          </div>
          <pre style={{ margin: 0, background: "#061433", color: "#FFE2A8", padding: "22px 24px", font: `13px/1.75 ${MONO}`, overflowX: "auto", boxShadow: "18px 24px 50px rgba(13,23,48,.35)" }}>
            <span style={{ color: "#8FA2CC" }}># list the attacks</span>{"\n"}
            curl {PUBLIC_API_URL}/v1/rob/cards{"\n"}
            <span style={{ color: "#8FA2CC" }}># play one, get the verdict and the tx</span>{"\n"}
            curl -X POST {PUBLIC_API_URL}/v1/rob/play \{"\n"}
            {"  "}-H 'content-type: application/json' \{"\n"}
            {"  "}-d '{"{"}"card":"forge-a-master-key"{"}"}'{"\n"}
            <span style={{ color: "#8FA2CC" }}># forge your own call</span>{"\n"}
            curl -X POST {PUBLIC_API_URL}/v1/rob/forge \{"\n"}
            {"  "}-H 'content-type: application/json' \{"\n"}
            {"  "}-d '{"{"}"method":"execute_near","args":{"{"}…{"}"}{"}"}'{"\n"}
            <span style={{ color: "#8FA2CC" }}># or add your own key to Ruggy, then sign yourself</span>{"\n"}
            curl -X POST {PUBLIC_API_URL}/v1/rob/session \{"\n"}
            {"  "}-H 'content-type: application/json' \{"\n"}
            {"  "}-d '{"{"}"publicKey":"ed25519:…"{"}"}'{"\n"}
            <span style={{ color: "#8FA2CC" }}># then POST /v1/rob/prepare, sign its hash, POST /v1/rob/play</span>
          </pre>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}

function loadKeyFresh(): Throwaway {
  try {
    localStorage.removeItem(KEY_STORE);
  } catch { /* fine */ }
  return loadKey();
}

function StatCell({ value, label, first = false }: { value: number | undefined; label: string; first?: boolean }) {
  return (
    <div className="stat" style={{ padding: first ? "26px 24px 26px 0" : "26px 24px", borderRight: "1px solid rgba(13,23,48,.14)" }}>
      <b className="carved" style={{ font: `800 50px/1 ${MONO}` }}>{value === undefined ? "–" : value.toLocaleString("en-US")}</b>
      <p style={{ margin: "8px 0 0", font: `700 12px ${BRAND}`, letterSpacing: ".2em" }}>{label}</p>
    </div>
  );
}

function Verdict({ shown, laws }: { shown: Shown | null; laws: string[] }) {
  if (!shown) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14, justifyContent: "center", height: "100%" }}>
        <span className="kick" style={{ color: "#8FA2CC" }}>Waiting for your move</span>
        <p style={{ margin: 0, font: `800 22px/1.2 ${BRAND}`, color: "#F3EFE6" }}>Pick a card below.</p>
        <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.55, color: "#C9D3EA" }}>
          It is sent to NEAR testnet as Ruggy, with a key made in your browser. The answer comes from the chain, in about two seconds.
        </p>
      </div>
    );
  }
  const title = shown.card?.title ?? "Forged call";
  if (shown.state === "sending") {
    return (
      <div className="vhead" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: 26, alignItems: "center" }}>
        <div className="rseal wait"><b>SIGNING…</b></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="kick" style={{ color: "#8FA2CC" }}>Sent to NEAR testnet</span>
          <p style={{ margin: 0, font: `800 22px/1.2 ${BRAND}`, color: "#F3EFE6" }}>{title}</p>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.55, color: "#C9D3EA" }}>{shown.card?.attempt ?? "Your call, signed with your throwaway key."}</p>
          {shown.card?.signer === "scripted" ? <small style={{ color: "#8FA2CC" }}>Several real transactions in a row: about ten seconds.</small> : null}
        </div>
      </div>
    );
  }
  if (shown.state === "error" || !shown.play) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="kick" style={{ color: "#F4A28C" }}>Not played</span>
        <p style={{ margin: 0, font: `800 22px/1.2 ${BRAND}`, color: "#F3EFE6" }}>{title}</p>
        <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.55, color: "#C9D3EA" }}>{shown.message}</p>
      </div>
    );
  }
  const play = shown.play;
  const counter = play.verdict === "counter";
  const paid = play.verdict === "paid";
  const vetoed = play.verdict === "vetoed";
  const color = counter || paid ? "#4FD1E8" : vetoed ? "#F2B544" : "#F4A28C";
  const word = counter ? "COUNTER" : paid ? "PAID" : vetoed ? "VETOED" : "DENIED";
  const kicker = paid ? "Paid · inside the law" : KICKER[play.refusedBy ?? ""] ?? "Refused";
  const why = paid
    ? "Every rule held: a listed supplier, inside the cap and the budget. The vault paid it, to one of the two suppliers the owners voted (accounts of ours)."
    : shown.card?.why ?? `The chain answered ${play.error}.`;
  const lawText = play.line !== null && laws[play.line] ? ` · law ${NUMERALS[play.line]}` : "";
  return (
    <>
      <div className="shake vhead" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: 26, alignItems: "center" }}>
        <div className={`rseal stamp${counter ? " counter" : ""}${paid ? " paid" : ""}${vetoed ? " veto" : ""}`}><b>{word}</b></div>
        <div className="fadein" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="kick" style={{ color }}>{kicker}</span>
          <p style={{ margin: 0, font: `800 22px/1.2 ${BRAND}`, color: "#F3EFE6" }}>{title}</p>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.55, color: "#C9D3EA" }}>{why}</p>
        </div>
      </div>
      {play.steps?.length ? (
        <div className="fadein steps4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
          {play.steps.map((step, index) => {
            const tone = STEP_TONE[step.label] ?? "#A9B6D6";
            const label = `${index + 1} · ${step.label}`;
            return (
              <div key={step.label} style={{ borderTop: `2px solid ${tone}`, paddingTop: 8 }}>
                {step.tx ? (
                  <a href={`https://testnet.nearblocks.io/txns/${step.tx}`} target="_blank" rel="noreferrer" style={{ font: `800 10.5px ${BRAND}`, letterSpacing: ".14em", color: tone }}>{label} ↗</a>
                ) : (
                  <b style={{ font: `800 10.5px ${BRAND}`, letterSpacing: ".14em", color: tone }}>{label}</b>
                )}
                <br />
                <small style={{ color: "#A9B6D6" }}>{step.detail}</small>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="fadein" style={{ background: "#010510", border: "1px solid rgba(143,162,204,.2)", padding: "16px 18px", font: `13px/1.7 ${MONO}`, color: "#A9B6D6", overflowX: "auto" }}>
        <div style={{ color: "#8FA2CC" }}>&gt; {play.call}</div>
        <div style={{ color: "#FFE2A8" }}>{"  "}signed with {play.signedBy} · NEAR testnet</div>
        <div style={{ color }}>
          {"  "}{counter ? `↺ COUNTER-OFFER · ${JSON.stringify({ counter: play.counter?.counter, expires_in: play.counter?.expires_in })}` : paid ? "✓ paid to a listed supplier" : vetoed ? `⊘ ${play.error} by the council${lawText}` : `✕ ${play.error}${lawText}`}
        </div>
        <div style={{ color: "#4FD1E8" }}>{"  "}{paid ? "nothing left the law: the supplier is ours" : "nothing moved"} · {(play.ms / 1000).toFixed(1)} s</div>
      </div>
      <div className="fadein" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        {play.nearblocks ? (
          <a href={play.nearblocks} target="_blank" rel="noreferrer" style={{ font: `700 12px ${BRAND}`, letterSpacing: ".16em", color: "#8FA2CC" }}>SEE THE TRANSACTION ON NEARBLOCKS →</a>
        ) : counter ? (
          <span style={{ fontSize: 13, color: "#8FA2CC" }}>An offer, not a transaction: Ruggy answers with what his law allows, valid 60 seconds.</span>
        ) : (
          <span style={{ fontSize: 13, color: "#8FA2CC" }}>No transaction to show: NEAR rejected it before the chain.</span>
        )}
      </div>
    </>
  );
}
