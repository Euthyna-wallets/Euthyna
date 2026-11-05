/** Hall of thieves: three categories and the recent forged calls, voted by players. Handoff: section LEADERBOARD + SHARE, left column. API: GET /v1/rob/hall. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { BRAND, MONO, robCall } from "./shared.js";
import type { Throwaway } from "./shared.js";

type Hall = {
  creative: { who: string; call: string; votes: number } | null;
  gas: { who: string; gasBurnt: string } | null;
  boldest: { who: string; amount: string; card: string } | null;
  recent: Array<{ id: string; call: string; votes: number; who: string }>;
};

const TILE = { border: "1px solid rgba(242,181,68,.3)", padding: 18, background: "rgba(6,20,51,.6)", display: "flex", flexDirection: "column" as const, minWidth: 0 };

/** Base units of TestUSDC (6 decimals), e.g. "20000000" → "20 USDC"; absurd cheques in scientific notation. */
export function usdc(amount: string): string {
  const digits = amount.replace(/^0+(?=\d)/, "");
  const whole = digits.length > 6 ? digits.slice(0, -6) : "0";
  const fraction = digits.padStart(7, "0").slice(-6).replace(/0+$/, "");
  if (whole.length > 12) return `${whole[0]}.${whole.slice(1, 3)}e${whole.length - 1} USDC`;
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""} USDC`;
}

/** Gas in Tgas, from the chain's gas units. */
export function tgas(gas: string): string {
  const value = Number(BigInt(gas) / 10_000_000_000n) / 100;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} Tgas`;
}

function cardName(card: string) {
  return card === "forge" ? "a forged call" : card.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

function Tile({ title, who, detail, sub }: { title: string; who: string | null; detail: string | null; sub: string }) {
  return (
    <div style={TILE}>
      <b style={{ font: `800 12px ${BRAND}`, letterSpacing: ".16em", color: "#F2B544" }}>{title}</b>
      <p style={{ margin: "10px 0 4px", font: `600 15px ${MONO}`, color: who ? "#F3EFE6" : "#8FA2CC", overflowWrap: "anywhere" }}>{who ?? "nobody yet"}</p>
      {detail ? <span style={{ font: `600 12.5px ${MONO}`, color: "#C9D3EA", marginBottom: 4, overflowWrap: "anywhere" }}>{detail}</span> : null}
      <small style={{ color: "#8FA2CC" }}>{sub}</small>
    </div>
  );
}

const VOTED_STORE = "rob.voted";
function votedIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(VOTED_STORE) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function RobHall(_props: { throwaway: Throwaway | null }) {
  const queryClient = useQueryClient();
  const hall = useQuery({ queryKey: ["rob-hall"], queryFn: () => robCall<Hall>("/v1/rob/hall"), retry: 1, refetchInterval: 30_000 });
  const [voted, setVoted] = useState<string[]>(votedIds);
  const [voteError, setVoteError] = useState<string | null>(null);

  async function vote(playId: string) {
    setVoteError(null);
    const remember = () => {
      const next = [...new Set([...voted, playId])].slice(-200);
      setVoted(next);
      try {
        localStorage.setItem(VOTED_STORE, JSON.stringify(next));
      } catch { /* this visit only */ }
    };
    try {
      await robCall("/v1/rob/hall/vote", { playId });
      remember();
      await queryClient.invalidateQueries({ queryKey: ["rob-hall"] });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "already_voted") remember();
      setVoteError(code === "own_play" ? "That one is yours: vote for someone else's call." : code === "already_voted" ? "You already voted for that call." : error instanceof Error ? error.message : String(error));
    }
  }

  const data = hall.data;
  return (
    <>
      <span className="kick" style={{ color: "#F2B544" }}>Hall of thieves</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: 14 }}>
        <Tile title="MOST CREATIVE" who={data?.creative?.who ?? null} detail={data?.creative ? `${data.creative.votes} ${data.creative.votes === 1 ? "vote" : "votes"}` : null} sub="voted by players" />
        <Tile title="MOST GAS BURNED" who={data?.gas?.who ?? null} detail={data?.gas ? tgas(data.gas.gasBurnt) : null} sub="from the chain" />
        <Tile title="BOLDEST CHEQUE" who={data?.boldest?.who ?? null} detail={data?.boldest ? `${usdc(data.boldest.amount)} · ${cardName(data.boldest.card)}` : null} sub="largest amount refused" />
      </div>
      {hall.isError ? <small style={{ color: "#8FA2CC" }}>The Hall is offline right now: the plays are still recorded.</small> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <b style={{ font: `800 12px ${BRAND}`, letterSpacing: ".16em", color: "#C9D3EA" }}>RECENT FORGED CALLS · VOTE THE MOST CREATIVE</b>
        {data && data.recent.length === 0 ? <small style={{ color: "#8FA2CC" }}>Nobody forged a call yet. Open expert mode above and be the first.</small> : null}
        {data?.recent.map((play) => {
          const done = voted.includes(play.id);
          return (
            <div key={play.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "10px 12px", border: "1px solid rgba(201,211,234,.16)", background: "rgba(6,20,51,.45)" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <code style={{ font: `600 12.5px ${MONO}`, color: "#F3EFE6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={play.call}>{play.call}</code>
                <small style={{ font: `500 11.5px ${MONO}`, color: "#8FA2CC" }}>{play.who}</small>
              </div>
              <button
                type="button"
                disabled={done}
                onClick={() => void vote(play.id)}
                aria-label={`Vote for ${play.call}`}
                style={{ minHeight: 36, padding: "0 12px", font: `800 11px ${BRAND}`, letterSpacing: ".14em", color: done ? "#8FA2CC" : "#F2B544", background: "transparent", border: `1px solid ${done ? "rgba(143,162,204,.35)" : "rgba(242,181,68,.55)"}`, cursor: done ? "default" : "pointer", whiteSpace: "nowrap" }}
              >
                {done ? "VOTED" : "VOTE"} · {play.votes}
              </button>
            </div>
          );
        })}
        {voteError ? <small role="alert" style={{ color: "#F4A28C" }}>{voteError}</small> : null}
      </div>
    </>
  );
}
