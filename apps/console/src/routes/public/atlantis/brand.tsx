/** EUTHYNA mark and the shared header and footer of the public site. */
import { Link } from "react-router-dom";

import "./atlantis.css";

export function Mark({ size = 30, ring = "#0D1730", title }: { size?: number; ring?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <circle cx="512" cy="512" r="307" fill="none" stroke={ring} strokeWidth="102" />
      <rect x="297" y="461" width="430" height="102" fill="#C9890C" />
      <rect x="41" y="461" width="72" height="102" fill="#C9890C" />
      <rect x="911" y="461" width="72" height="102" fill="#C9890C" />
    </svg>
  );
}

export function SiteHeader({ current }: { current?: "home" | "whitepaper" }) {
  const home = current === "home";
  const section = (hash: string) => (home ? hash : `/${hash}`);
  return (
    <header className="top g">
      <div className="w">
        <Link className="brand" to="/"><Mark />EUTHYNA</Link>
        <nav className="links" aria-label="Site">
          <a href={section("#law")}>Infrastructure</a>
          <a href={section("#chains")}>Chains</a>
          <a href={section("#recovery")}>Recovery</a>
          <a href={section("#build")}>Developers</a>
          <a className="atl" href={section("#atlantis")}>Atlantis</a>
          <Link to="/market">Market</Link>
          <Link to="/whitepaper" aria-current={current === "whitepaper" ? "page" : undefined}>Whitepaper</Link>
          <Link className="btn ink" to="/overview">Open app</Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <>
      <div className="meander" aria-hidden="true" />
      <footer className="g">
        <div className="w">
          <span className="foot-brand">EUTHYNA · ATLANTIS</span>
          <span>NEAR Hackathon 2026 · testnet only · contracts not audited · <Link to="/whitepaper">Whitepaper</Link></span>
        </div>
      </footer>
    </>
  );
}
