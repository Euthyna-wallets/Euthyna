/**
 * Chrome of the public site: the night header, the footer and the small
 * pieces every public page shares (logo, seal, kicker).
 *
 * Visual reference: design-handoff/site/source/*.html (the same header and
 * footer on every page). Text and links stay those of main; only the style
 * comes from the handoff.
 */
import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

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

/** Pages of their own, after the home sections. */
const PAGES: Array<{ href: string; label: string }> = [
  { href: "/rob", label: "Rob the Agent" },
  { href: "/whitepaper", label: "Whitepaper" },
];

/** Scrolls to the section named by the URL hash (React Router changes the URL but does not scroll). */
function scrollToHash(hash: string, behavior: ScrollBehavior = "smooth") {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  if (!id) return false;
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ behavior, block: "start" });
  return true;
}

/** Header of every public page: marble-dark bar, section anchors, Rob the Agent, OPEN APP; a menu button below 900px. */
export function SiteHeader() {
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Arriving on "/#security" from another page, or by a pasted link: the section renders after the route, so try a few frames.
  useEffect(() => {
    setOpen(false);
    if (!location.hash) return;
    let tries = 0;
    let frame = 0;
    const attempt = () => {
      if (scrollToHash(location.hash, tries === 0 ? "auto" : "smooth") || tries++ > 30) return;
      frame = window.requestAnimationFrame(attempt);
    };
    frame = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(frame);
  }, [location.pathname, location.hash]);

  // Clicking a section link while already on the home page, even the same link twice.
  const onSection = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    setOpen(false);
    if (location.pathname !== "/") return;
    const hash = href.slice(href.indexOf("#"));
    if (scrollToHash(hash)) {
      event.preventDefault();
      window.history.replaceState(null, "", `/${hash}`);
    }
  };

  const linkStyle: CSSProperties = { textDecoration: "none" };
  const links = (
    <>
      {SECTIONS.map((section) => (
        <Link key={section.href} to={section.href} onClick={onSection(section.href)} style={linkStyle}>
          {section.label}
        </Link>
      ))}
      {PAGES.map((page) => (
        <Link key={page.href} to={page.href} onClick={() => setOpen(false)} style={page.href === "/rob" ? { ...linkStyle, color: "#F2B544" } : linkStyle}>
          {page.label}
        </Link>
      ))}
    </>
  );

  return (
    <div className="wrap" style={{ position: "relative", display: "flex", alignItems: "center", gap: 28, paddingTop: 26, paddingBottom: 26 }}>
      <Link
        to="/"
        style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", color: "#F3EFE6", font: "700 18px Cinzel, serif", letterSpacing: ".22em" }}
      >
        <Logo />
        EUTHYNA
      </Link>
      <nav className="navlinks" aria-label="Site" style={{ display: "flex", gap: 26, marginLeft: "auto", fontSize: 14, fontWeight: 600, color: "#C9D3EA" }}>
        {links}
      </nav>
      <button
        type="button"
        className="navtoggle"
        aria-expanded={open}
        aria-controls="site-menu"
        onClick={() => setOpen((value) => !value)}
        style={{ marginLeft: "auto", minHeight: 44, padding: "10px 14px", background: "none", border: "1px solid rgba(201,211,234,.35)", color: "#F3EFE6", font: "700 12px Cinzel, serif", letterSpacing: ".18em", borderRadius: 2, cursor: "pointer" }}
      >
        {open ? "CLOSE" : "MENU"}
      </button>
      <Link
        to="/overview"
        className="openapp"
        style={{ marginLeft: 18, textDecoration: "none", padding: "11px 20px", border: "1px solid rgba(242,181,68,.6)", color: "#F2B544", font: "700 13px Cinzel, serif", letterSpacing: ".18em", borderRadius: 2 }}
      >
        OPEN APP
      </Link>
      {open ? (
        <nav
          id="site-menu"
          className="navmenu"
          aria-label="Site menu"
          style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 40, display: "flex", flexDirection: "column", gap: 4, padding: "10px 20px 18px", background: "#061433", borderTop: "1px solid #1F3A6E", borderBottom: "1px solid #1F3A6E", fontSize: 16, fontWeight: 600, color: "#C9D3EA" }}
        >
          {links}
          <Link to="/overview" className="menu-openapp" onClick={() => setOpen(false)} style={{ ...linkStyle, color: "#F2B544", font: "700 14px Cinzel, serif", letterSpacing: ".18em" }}>
            OPEN APP
          </Link>
        </nav>
      ) : null}
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
          Testnets only · contracts not audited · <a href="https://github.com/Euthyna-wallets/Euthyna">GitHub</a> ·{" "}
          <Link to="/rob">Rob the Agent</Link> · <Link to="/whitepaper">Whitepaper</Link>
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
