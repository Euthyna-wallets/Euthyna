# docs.euthyna.io

The public documentation, built with [Starlight](https://starlight.astro.build/) and served by Cloudflare Pages.

The pages are not written here. `scripts/sync.mjs` copies the repository's Markdown (`docs/*.md`,
`Architecture.md`, `CLAIMS.md`) into `src/content/docs/` at each build, adds the front matter and rewrites the
links: another published page goes to that page, any other file goes to GitHub. To change a page, edit the source
file. To publish a new one, add it to `pages` in `scripts/sync.mjs` and to the sidebar in `astro.config.mjs`.
Only `src/content/docs/index.mdx` (the home page) lives here.

Internal notes stay out: `dao-spike.md`, `design-branch.md`, `explore.md`, `post-hackathon.md`, `vault-testnet.md`.

This folder is its own pnpm workspace: the root workspace and the Docker image never install or build it.

```bash
cd docs-site
pnpm install
pnpm dev      # http://localhost:4321
pnpm build    # dist/
```

## Deployment

`.github/workflows/docs-site.yml` builds every pull request that touches the docs, and deploys `main` to the
Cloudflare Pages project `euthyna-docs` when the repository has the secrets `CLOUDFLARE_API_TOKEN` (permission
Cloudflare Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`.

Once:

1. Create the project: `pnpm wrangler pages project create euthyna-docs --production-branch main`
2. In the Pages project, Custom domains → add `docs.euthyna.io`.
3. At OVH (the DNS of euthyna.io), add `docs CNAME euthyna-docs.pages.dev.`
