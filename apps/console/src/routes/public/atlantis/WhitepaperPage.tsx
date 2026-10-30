import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";

import { Markdown } from "../../../lib/markdown.js";
import { SiteFooter, SiteHeader } from "./brand.js";
import whitepaper from "./whitepaper.md?raw";

/** The whitepaper is whitepaper.md next to this file: edit the markdown, not this page. */
export function WhitepaperPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Euthyna Whitepaper";
    return () => { document.title = previous; };
  }, []);
  const sections = useMemo(
    () => whitepaper.split("\n").filter((line) => /^# /.test(line)).map((line) => line.replace(/^# /, "")),
    [],
  );
  return (
    <div className="eu-site">
      <SiteHeader current="whitepaper" />
      <main className="wp g">
        <div className="w">
          <span className="kicker">Whitepaper · draft</span>
          <h1 className="insc">Euthyna Whitepaper</h1>
          <div className="wp-meta"><span>Wallets and delegation for AI agents</span><span className="pill">Oct 29, 2026</span><span className="pill">@Koplo</span></div>
          <div className="wp-actions">
            <a className="btn ink" href="/Euthyna-Whitepaper.pdf" download>Download the PDF</a>
            <Link className="btn line" to="/">Back to the site</Link>
          </div>
          <nav className="wp-toc" aria-label="Sections">
            {sections.map((title) => <a key={title} href={`#${slug(title)}`}>{title}</a>)}
          </nav>
          <Sections source={whitepaper} />
        </div>
      </main>
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
      {blocks.map((block) => {
        const [title = "", ...rest] = block.split("\n");
        return (
          <section key={title} id={slug(title)}>
            <Markdown source={`# ${title}\n${rest.join("\n")}`} />
          </section>
        );
      })}
    </>
  );
}
