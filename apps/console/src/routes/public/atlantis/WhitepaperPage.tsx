/**
 * Whitepaper. Visual reference: design-handoff/site/source/whitepaper.html and
 * screens/12-whitepaper-page-desktop.png
 * The text comes from whitepaper.md: edit the markdown, never this page.
 */
import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";

import { Markdown } from "../../../lib/markdown.js";
import "../../../styles/site.css";
import { Kicker, SiteFooter, SiteHeader } from "../site/SiteChrome.js";
import whitepaper from "./whitepaper.md?raw";

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI"];

export function WhitepaperPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Euthyna Whitepaper";
    return () => {
      document.title = previous;
    };
  }, []);
  const sections = useMemo(() => whitepaper.split("\n").filter((line) => /^# /.test(line)).map((line) => line.replace(/^# /, "")), []);

  return (
    <div className="site-root">
      <section className="nightm" style={{ position: "relative" }}>
        <SiteHeader />
        <div className="wrap" style={{ paddingTop: 56, paddingBottom: 64, display: "grid", gridTemplateColumns: "minmax(0,1fr) 360px", gap: 48, alignItems: "end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <Kicker>Whitepaper · draft</Kicker>
            <h1 style={{ margin: 0, font: `900 clamp(48px, 6vw, 84px)/0.98 Cinzel, serif`, letterSpacing: ".03em" }}>
              <span className="leaf">EUTHYNA</span>
              <br />
              <span style={{ color: "#F3EFE6" }}>WHITEPAPER</span>
            </h1>
            <p style={{ margin: 0, fontSize: 19, color: "#C9D3EA" }}>Wallets and delegation for AI agents.</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", font: `600 12px 'JetBrains Mono', monospace`, color: "#8FA2CC" }}>
              <span>OCT 29, 2026</span>
              <span>·</span>
              <span>KOPLO</span>
              <span>·</span>
              <span>TESTNET</span>
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
              <a href="/Euthyna-Whitepaper.pdf" download className="ori" style={{ textDecoration: "none", padding: "16px 26px", color: "#2A0D04", font: `800 13px Cinzel, serif`, letterSpacing: ".18em" }}>
                DOWNLOAD THE PDF
              </a>
              <Link to="/" className="btnl btn-ghost" style={{ padding: "15px 24px" }}>
                BACK TO THE SITE
              </Link>
            </div>
          </div>
          <div
            className="marblelit"
            style={{ height: 300, borderRadius: "150px 150px 2px 2px", boxShadow: "24px 30px 60px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "#0D1730" }}
            aria-hidden="true"
          >
            <svg width="74" height="74" viewBox="0 0 1024 1024">
              <circle cx="512" cy="512" r="307" fill="none" stroke="#8E8473" strokeWidth="90" />
              <rect x="297" y="461" width="430" height="102" fill="#C9890C" />
              <rect x="41" y="461" width="72" height="102" fill="#C9890C" />
              <rect x="911" y="461" width="72" height="102" fill="#C9890C" />
            </svg>
            <span className="carved" style={{ font: `900 17px Cinzel, serif`, letterSpacing: ".28em" }}>
              EUTHYNA
            </span>
            <span style={{ font: `700 10px Cinzel, serif`, letterSpacing: ".3em", color: "#8A5A00" }}>{sections.length} SECTIONS</span>
          </div>
        </div>
        <div className="fluteline" style={{ height: 10, opacity: 0.6 }} />
      </section>

      <section className="marble" style={{ padding: "72px 0 90px", color: "#0D1730" }}>
        <div className="wrap wp-layout" style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 780px)", gap: 64, justifyContent: "center", alignItems: "start" }}>
          <nav className="toc" aria-label="Sections">
            <Kicker color="#8A5A00" style={{ marginBottom: 10 }}>
              Contents
            </Kicker>
            {sections.map((title, index) => (
              <a key={title} href={`#${slug(title)}`}>
                <b>{ROMAN[index] ?? String(index + 1)}</b>
                <span>{title}</span>
              </a>
            ))}
          </nav>
          <article className="wp-body">
            <Sections source={whitepaper} />
          </article>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Renders each "# Title" block on its own so the table of contents can link to it. */
function Sections({ source }: { source: string }) {
  const blocks = source.split(/^# /m).filter((block) => block.trim());
  return (
    <>
      {blocks.map((block, index) => {
        const [title = "", ...rest] = block.split("\n");
        return (
          <section key={title} id={slug(title)}>
            <h1>
              <small>{ROMAN[index] ?? String(index + 1)}</small>
              {title}
            </h1>
            <Markdown source={rest.join("\n")} />
          </section>
        );
      })}
    </>
  );
}
