/**
 * Chrome of the public site: the night header, the footer and the small
 * pieces every public page shares (logo, seal, kicker).
 *
 * Visual reference: design-handoff/site/source/*.html (the same header and
 * footer on every page). Text and links stay those of main; only the style
 * comes from the handoff.
 */
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <circle cx="512" cy="512" r="307" fill="none" stroke="#F3EFE6" strokeWidth="102" />
      <rect x="297" y="461" width="430" height="102" fill="#C9890C" />
      <rect x="41" y="461" width="72" height="102" fill="#C9890C" />
      <rect x="911" y="461" width="72" height="102" fill="#C9890C" />
    </svg>
  );
}

const SECTIONS: Array<{ href: string; label: string }> = [
  { href: "/#how", label: "How it works" },
  { href: "/#uses", label: "Use cases" },
  { href: "/#security", label: "Security" },
  { href: "/#atlantis", label: "Atlantis" },
  { href: "/#market", label: "Market" },
  { href: "/#dev", label: "Developers" },
];

/** Header of every public page: marble-dark bar, section anchors, OPEN APP. */
export function SiteHeader() {
  return (
    <div className="wrap" style={{ display: "flex", alignItems: "center", gap: 28, paddingTop: 26, paddingBottom: 26 }}>
      <Link
        to="/"
        style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", color: "#F3EFE6", font: "700 18px Cinzel, serif", letterSpacing: ".22em" }}
      >
        <Logo />
        EUTHYNA
      </Link>
      <nav className="navlinks" aria-label="Site" style={{ display: "flex", gap: 30, marginLeft: "auto", fontSize: 14, fontWeight: 600, color: "#C9D3EA" }}>
        {SECTIONS.map((section) => (
          <Link key={section.href} to={section.href} style={{ textDecoration: "none" }}>
            {section.label}
          </Link>
        ))}
        <Link to="/whitepaper" style={{ textDecoration: "none" }}>Whitepaper</Link>
      </nav>
      <Link
        to="/overview"
        style={{ marginLeft: 18, textDecoration: "none", padding: "11px 20px", border: "1px solid rgba(242,181,68,.6)", color: "#F2B544", font: "700 13px Cinzel, serif", letterSpacing: ".18em", borderRadius: 2 }}
      >
        OPEN APP
      </Link>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer style={{ background: "#030918", padding: "0 0 36px" }}>
      <div className="fluteline" style={{ height: 12, opacity: 0.7 }} />
      <div
        className="wrap"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20, flexWrap: "wrap", paddingTop: 32, fontSize: 13.5, color: "#8FA2CC" }}
      >
        <span style={{ font: "700 14px Cinzel, serif", letterSpacing: ".24em", color: "#F3EFE6" }}>EUTHYNA · ATLANTIS</span>
        <span>
          Testnets only · contracts not audited · <a href="https://github.com/Euthyna-wallets/MandateOS">GitHub</a> ·{" "}
          <Link to="/whitepaper">Whitepaper</Link>
        </span>
      </div>
    </footer>
  );
}

/** A struck bronze seal; `refused` tilts it towards terracotta. */
export function Seal({ label, size = 104, refused = false, fontSize }: { label: string; size?: number; refused?: boolean; fontSize?: number | undefined }) {
  return (
    <div className={`seal${refused ? " seal-refused" : ""}`} style={{ width: size, height: size }}>
      <span style={{ color: refused ? "#6E1C0A" : "#4A2C06", ...(fontSize ? { fontSize } : {}) }}>{label}</span>
    </div>
  );
}

export function Kicker({ children, color = "#F2B544", style }: { children: ReactNode; color?: string; style?: CSSProperties }) {
  return (
    <span className="kick" style={{ color, ...style }}>
      {children}
    </span>
  );
}

/** The hero background: the ten-second loop, or its poster with reduced motion. */
export function HeroVideo() {
  return (
    <>
      <video className="hero-video" autoPlay muted loop playsInline preload="metadata" poster="/media/hero-poster.jpg" aria-hidden="true">
        <source src="/media/hero-loop.mp4" type="video/mp4" />
      </video>
      <div className="hero-veil" aria-hidden="true" />
    </>
  );
}
