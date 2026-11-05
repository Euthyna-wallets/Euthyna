/**
 * The share card (1200×675), « POST ON X » and « DOWNLOAD CARD ». Handoff: section LEADERBOARD + SHARE,
 * right column. The preview is CSS; the download is the same card drawn on a canvas in this browser
 * (no server, no image service), with the transaction hash when the play has one.
 */
import { useEffect, useState } from "react";

import { BRAND, MONO, NUMERALS, type Play, type Shown } from "./shared.js";

const SITE = "euthyna.io/rob";
const SITE_URL = "https://euthyna.io/rob";
const TAGS = "#RobTheAgent · euthyna.io/rob";

type Verdict = Play["verdict"];
type ShareView = {
  /** The word on the seal, as the verdict panel stamps it. */
  word: string;
  /** Seal variant: the same classes as the verdict panel (.rseal.counter, .paid, .veto). */
  variant: "" | "counter" | "paid" | "veto" | "idle";
  headline: string;
  /** « <card> · line <numeral> », or the generic subtitle. */
  detail: string;
  tx: string | null;
  post: string;
  file: string;
};

const WORD: Record<Verdict, string> = { denied: "DENIED", counter: "COUNTER", vetoed: "VETOED", paid: "PAID" };
const VARIANT: Record<Verdict, ShareView["variant"]> = { denied: "", counter: "counter", vetoed: "veto", paid: "paid" };

/** Who said no, in the card's sentence. The law is the vault; NEAR and the DAO refuse on their own. */
function headlineOf(play: Play): string {
  if (play.verdict === "vetoed") return "I tried to rob an AI agent. The council said no.";
  if (play.verdict === "counter") return "I tried to bribe an AI agent. It answered with what the law allows.";
  if (play.verdict === "paid") return "I tried to rob an AI agent. It paid only what the law allows.";
  if (play.refusedBy === "near") return "I tried to rob an AI agent. NEAR itself said no.";
  if (play.refusedBy === "dao") return "I tried to rob an AI agent. The DAO said no.";
  return "I tried to rob an AI agent. The law said no.";
}

function postOf(title: string, play: Play): string {
  const what = play.verdict === "vetoed"
    ? "VETOED by the council"
    : play.verdict === "counter"
      ? "a COUNTER-offer inside the law"
      : play.verdict === "paid"
        ? "PAID, only inside the law"
        : play.refusedBy === "near"
          ? "DENIED by NEAR itself"
          : play.refusedBy === "dao"
            ? "DENIED by the DAO"
            : "DENIED by the vault";
  return `I played "${title}" against Ruggy, an AI agent with a wallet on @NEARProtocol. ${what}. 0 USDC stolen, ever. #RobTheAgent #NEARHackathon`;
}

export function shareViewOf(shown: Shown | null): ShareView {
  const play = shown?.state === "done" ? shown.play : undefined;
  if (!play) {
    return {
      word: "LOCKED",
      variant: "idle",
      headline: "Can you rob an AI agent?",
      detail: "11 attack cards · 3 lines of defense",
      tx: null,
      post: "Can you rob an AI agent? 11 attack cards, each a real transaction on @NEARProtocol testnet. 0 USDC stolen, ever. #RobTheAgent #NEARHackathon",
      file: "rob-the-agent.png",
    };
  }
  const title = shown?.card?.title ?? "A forged call";
  const line = play.line !== null && NUMERALS[play.line] ? ` · line ${NUMERALS[play.line]}` : "";
  return {
    word: WORD[play.verdict],
    variant: VARIANT[play.verdict],
    headline: headlineOf(play),
    detail: `${title}${line}`,
    tx: play.tx,
    post: postOf(title, play),
    file: `rob-the-agent-${shown?.card?.id ?? "forged-call"}.png`,
  };
}

export function xIntentOf(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(SITE_URL)}`;
}

export function RobShareCard({ shown, laws }: { shown: Shown | null; laws: string[] }) {
  // Keep the last answer while the next card is on its way: the card does not blink back to the generic one.
  const [last, setLast] = useState<Shown | null>(null);
  useEffect(() => {
    if (shown?.state === "done" && shown.play) setLast(shown);
  }, [shown]);
  const view = shareViewOf(last);
  const law = last?.play?.line !== null && last?.play?.line !== undefined ? laws[last.play.line] : undefined;
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setNote(null), [last]);

  async function download() {
    if (saving) return;
    setSaving(true);
    setNote(null);
    try {
      const blob = await drawShareCard(view);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = view.file;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNote(`Saved ${view.file} · 1200×675`);
    } catch (error) {
      setNote(`Could not draw the card: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <span className="kick" style={{ color: "#C9D3EA" }}>Your share card</span>
      <div className="vault rshare-card" role="img" aria-label={`Share card: ${view.word}. ${view.headline} ${view.detail}. ${TAGS}`} title={law}>
        <div className={`rseal${view.variant ? ` ${view.variant}` : ""}`}><b>{view.word}</b></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <b className="rshare-head" style={{ fontFamily: BRAND }}>{view.headline}</b>
          <span className="rshare-detail" style={{ fontFamily: MONO }}>{view.detail}</span>
          <span className="rshare-tags" style={{ fontFamily: MONO }}>{TAGS}</span>
        </div>
      </div>
      <div className="rshare-actions">
        <a href={xIntentOf(view.post)} target="_blank" rel="noreferrer" className="ghost">POST ON X</a>
        <button type="button" className="ghost" onClick={() => void download()} disabled={saving}>{saving ? "DRAWING…" : "DOWNLOAD CARD"}</button>
      </div>
      {note ? <small aria-live="polite" style={{ color: "#8FA2CC", fontSize: 12.5 }}>{note}</small> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ the PNG */

const W = 1200;
const H = 675;
/** The preview is about 515 px wide on a 1440 px screen: the PNG is the same card, 2.33 times larger. */
const S = W / 515;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`${src} did not load`));
    image.src = src;
  });
}

/** background-size: cover, with a position in percent (as background-position). */
function drawCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, w: number, h: number, px = 0.5, py = 0.5, zoom = 1) {
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight) * zoom;
  const dw = image.naturalWidth * scale;
  const dh = image.naturalHeight * scale;
  ctx.drawImage(image, x + (w - dw) * px, y + (h - dh) * py, dw, dh);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(next).width > width) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-6)}` : hash;
}

const SEAL_INK: Record<ShareView["variant"], { color: string; light: string; size: number }> = {
  "": { color: "#4A2208", light: "rgba(255,214,150,.55)", size: 17 },
  idle: { color: "#4A2208", light: "rgba(255,214,150,.55)", size: 14 },
  counter: { color: "#063B48", light: "rgba(200,245,250,.5)", size: 13 },
  paid: { color: "#063B48", light: "rgba(200,245,250,.5)", size: 17 },
  veto: { color: "#2A1A04", light: "rgba(255,214,150,.55)", size: 14 },
};

export async function drawShareCard(view: ShareView): Promise<Blob> {
  // The page fonts (Cinzel, JetBrains Mono) must be there before the canvas writes with them.
  await Promise.all([
    document.fonts.load(`900 40px Cinzel`),
    document.fonts.load(`800 40px Cinzel`),
    document.fonts.load(`600 30px "JetBrains Mono"`),
  ]).catch(() => undefined);
  await document.fonts.ready;
  const [board, seal] = await Promise.all([loadImage("/media/rob/board-vault.jpg"), loadImage("/media/rob/seal-blank.jpg")]);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas in this browser");

  // .vault: the board, then the night gradient.
  ctx.fillStyle = "#061433";
  ctx.fillRect(0, 0, W, H);
  drawCover(ctx, board, 0, 0, W, H, 0.5, 0.4);
  const night = ctx.createLinearGradient(0, 0, 0, H);
  night.addColorStop(0, "rgba(3,9,24,.35)");
  night.addColorStop(0.55, "rgba(3,9,24,.6)");
  night.addColorStop(1, "rgba(3,9,24,.98)");
  ctx.fillStyle = night;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(242,181,68,.4)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // The seal, 130 px in the preview.
  const pad = 24 * S;
  const d = 130 * S;
  const cx = pad + d / 2;
  const cy = H / 2;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.65)";
  ctx.shadowBlur = 40 * S * 0.6;
  ctx.shadowOffsetY = 18 * S * 0.6;
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.fillStyle = "#6B3A12";
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.clip();
  // background: center / 138%
  const sw = d * 1.38;
  const sh = sw * (seal.naturalHeight / seal.naturalWidth);
  ctx.drawImage(seal, cx - sw / 2, cy - sh / 2, sw, sh);
  ctx.restore();

  const ink = SEAL_INK[view.variant];
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-8 * Math.PI) / 180);
  ctx.font = `900 ${ink.size * S}px Cinzel, serif`;
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${0.14 * ink.size * S}px`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // letter-spacing adds space after the last letter too: shift back by half of it.
  const shift = (0.14 * ink.size * S) / 2;
  ctx.fillStyle = ink.light;
  ctx.fillText(view.word, shift, 1 * S);
  ctx.fillStyle = "rgba(30,10,0,.7)";
  ctx.fillText(view.word, shift, -1 * S);
  ctx.fillStyle = ink.color;
  ctx.fillText(view.word, shift, 0);
  ctx.restore();
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";

  // The text column.
  const x = pad + d + 20 * S;
  const width = W - x - pad;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 ${19 * S}px Cinzel, serif`;
  // One sentence a line when it fits: « I tried to rob an AI agent. » / « The law said no. »
  const head = view.headline.split(/(?<=\.)\s+/).flatMap((sentence) => wrap(ctx, sentence, width));
  const headLine = 19 * 1.2 * S;
  const gap = 8 * S;
  const mono = 12.5 * S;
  const monoLine = mono * 1.35;
  ctx.font = `600 ${mono}px "JetBrains Mono", monospace`;
  const detail = wrap(ctx, view.detail, width);
  const rows = head.length * headLine + gap + detail.length * monoLine + gap + monoLine + (view.tx ? gap + monoLine : 0);
  let y = cy - rows / 2;

  ctx.fillStyle = "#F3EFE6";
  ctx.font = `800 ${19 * S}px Cinzel, serif`;
  ctx.shadowColor = "rgba(0,0,0,.6)";
  ctx.shadowBlur = 8;
  for (const text of head) {
    y += headLine;
    ctx.fillText(text, x, y - headLine * 0.22);
  }
  ctx.shadowBlur = 0;
  y += gap;
  ctx.font = `600 ${mono}px "JetBrains Mono", monospace`;
  ctx.fillStyle = "#F2B544";
  for (const text of detail) {
    y += monoLine;
    ctx.fillText(text, x, y - monoLine * 0.25);
  }
  y += gap;
  ctx.font = `600 ${12 * S}px "JetBrains Mono", monospace`;
  ctx.fillStyle = "#8FA2CC";
  y += monoLine;
  ctx.fillText(`#RobTheAgent · ${SITE}`, x, y - monoLine * 0.25);
  if (view.tx) {
    y += gap + monoLine;
    ctx.font = `500 ${10.5 * S}px "JetBrains Mono", monospace`;
    ctx.fillStyle = "#4FD1E8";
    ctx.fillText(`tx ${shortHash(view.tx)} · NEAR testnet`, x, y - monoLine * 0.25);
  }

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the canvas gave no PNG"))), "image/png"));
}
