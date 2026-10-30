# Design branch: `design/atlantis-site`

The public site (EUTHYNA, Atlantis, whitepaper) is designed on its own branch so it never disturbs the work on `main`.

## Rules

1. **Never push to `main`.** Work on `design/atlantis-site`, or a branch cut from it. Merge only through a pull request that Koplo or Valentin reviews.
2. **Do not touch what others are building.** The branch only adds files under `apps/console/src/routes/public/atlantis/`, `apps/console/public/Euthyna-Whitepaper.pdf`, `CLAIMS.md` and this file, and changes the routes in `apps/console/src/App.tsx` (see below). Contracts, SDK, API, MCP, the console pages (`/overview`, `/roles`, `/market`...) and `ExplorePage.tsx` stay as they are.
3. **Keep up to date.** Before each session: `git fetch origin && git rebase origin/main` (or merge `origin/main`), then `pnpm --filter @mandateos/sdk build`, `pnpm --filter @mandateos/console typecheck`, `pnpm --filter @mandateos/console test`.
4. **State only what the code does.** Every claim on the site has a row in `CLAIMS.md`. New claim: add the row first. A feature that is not built is labelled NEXT or PLANNED. Testnet only.
5. **English on the site.** Identity unchanged: name, logo, palette, fonts (Cinzel, Plus Jakarta Sans), seal.

## What changes in shared files

`apps/console/src/App.tsx`, three routes:

| Route | Before | On this branch |
| --- | --- | --- |
| `/` | `ExplorePage` | `AtlantisLanding` |
| `/whitepaper` | none | `WhitepaperPage` |
| `/explore` | redirect to `/` | `ExplorePage` (unchanged page, kept reachable) |

The styles are scoped under `.eu-site` and never touch `styles.css`.

## Editing the whitepaper

The text is `apps/console/src/routes/public/atlantis/whitepaper.md`: a `# Title` starts a section (it also builds the table of contents), tables and links work. Replace `apps/console/public/Euthyna-Whitepaper.pdf` when the PDF changes.
