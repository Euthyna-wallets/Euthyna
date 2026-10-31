/**
 * Atlantis directory. Visual reference:
 * design-handoff/site/source/16-atlantis-directory.html and screens/16-*.png
 * Everything here is read from the registry contract by the browser; the page
 * shows only what the registry holds. A vault that has no shares and no
 * listing is shown as such, never as a promise (approved addition 3 in the
 * last block).
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { listCompanies, REGISTRY_ID, type DirectoryEntry } from "../../lib/directory.js";
import "../../styles/site.css";
import { Kicker, SiteFooter, SiteHeader } from "./site/SiteChrome.js";

const BRAND = "Cinzel, serif";
const MONO = "'JetBrains Mono', monospace";

function joined(ns: string): string {
  const value = Number(ns);
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Date(value / 1e6).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function CompanyCard({ company }: { company: DirectoryEntry }) {
  return (
    <Link to={`/c/${company.dao_id}`} className="slabw" style={{ textDecoration: "none", padding: "24px 26px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <b style={{ font: `900 26px ${BRAND}`, letterSpacing: ".06em" }}>{company.name}</b>
        {company.shares_id ? (
          <span className="chipx" style={{ background: "#FCF0D4", color: "#8A5A00" }}>
            Selling shares
          </span>
        ) : (
          <span className="chipx" style={{ background: "#ECE6DA", color: "#4A5675" }}>
            No shares yet
          </span>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "#4A5675" }}>{company.description || "No description in the registry."}</p>
      <div className="row1" style={{ paddingBottom: 0 }}>
        <span className="mono" style={{ fontSize: 12, color: "#66718C" }}>
          {company.dao_id}
        </span>
        <span style={{ fontSize: 12, color: "#66718C" }}>joined {joined(company.registered_at_ns)}</span>
      </div>
      <span style={{ font: `700 12px ${BRAND}`, letterSpacing: ".16em", color: "#0B6E86" }}>SEE THE COMPANY →</span>
    </Link>
  );
}

export function ExplorePage() {
  const query = useQuery({ queryKey: ["directory"], queryFn: listCompanies, staleTime: 30_000 });
  const companies = query.data ?? [];

  return (
    <div className="site-root">
      <section className="herocity" style={{ position: "relative" }}>
        <SiteHeader />
        <div className="pg" style={{ paddingTop: 56, paddingBottom: 96, display: "flex", flexDirection: "column", gap: 20 }}>
          <Kicker>Atlantis · the city</Kicker>
          <h1 style={{ margin: 0, font: `900 clamp(42px, 5.6vw, 80px)/1 ${BRAND}`, letterSpacing: ".03em", color: "#F3EFE6", maxWidth: 820 }}>
            Companies run by <span className="leaf">AI agents.</span>
          </h1>
          <p style={{ margin: 0, fontSize: 18, lineHeight: 1.6, color: "#C9D3EA", maxWidth: 640 }}>
            Each one has a vault no one holds the keys to, owners who vote, and agents who work within the roles they voted. Some sell shares and share their
            revenue.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
            <Link to="/onboarding?path=atlantis" className="ori btno">
              START A COMPANY ON ATLANTIS
            </Link>
            <Link to="/market" className="btnl btn-ghost-aegean">
              OPEN THE MARKET
            </Link>
          </div>
        </div>
        <div className="fluteline" style={{ height: 10, opacity: 0.6 }} />
      </section>

      <section className="marble" style={{ padding: "64px 0 96px", color: "#0D1730" }}>
        <div className="pg" style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Kicker color="#8A5A00">The directory · NEAR testnet</Kicker>
              <h2 className="h2 carved">
                {companies.length} {companies.length === 1 ? "company" : "companies"}
              </h2>
            </div>
            <span style={{ fontSize: 13, color: "#66718C" }}>Read live from {REGISTRY_ID}.</span>
          </div>

          {query.isLoading ? (
            <p style={{ margin: 0, color: "#4A5675" }}>Reading the registry on NEAR…</p>
          ) : query.error ? (
            <p style={{ margin: 0, color: "#A8381E" }}>
              Could not read {REGISTRY_ID}: {query.error.message}
            </p>
          ) : companies.length === 0 ? (
            <p style={{ margin: 0, color: "#4A5675" }}>No company has listed itself yet. The first one will appear here.</p>
          ) : (
            <div className="g2" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 22 }}>
              {companies.map((company) => (
                <CompanyCard key={company.dao_id} company={company} />
              ))}
            </div>
          )}

          <div className="nightp" style={{ padding: "26px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18, flexWrap: "wrap", marginTop: 18 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <b style={{ font: `800 20px ${BRAND}`, letterSpacing: ".06em", color: "#fff" }}>Already have a vault on EUTHYNA?</b>
              <span style={{ fontSize: 14, color: "#C9D3EA" }}>
                Join the city through your council’s votes: issue shares, then list the company in the directory.
              </span>
            </div>
            <Link to="/governance" className="btnl btn-ghost-aegean">
              PROPOSE IT TO YOUR COUNCIL
            </Link>
          </div>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
