// Copies the repository's Markdown docs into the Starlight content folder.
// The files in docs/ (and Architecture.md, CLAIMS.md) stay the single source: this script only adds
// the front matter Starlight needs and rewrites links so they work on docs.euthyna.io.
//   - a link to another published page goes to that page
//   - a link to any other file of the repository goes to GitHub
//   - an image is copied into public/media and served from the site
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const repo = resolve(site, "..");
const contentDir = join(site, "src/content/docs");
const mediaDir = join(site, "public/media");
const github = "https://github.com/Euthyna-wallets/Euthyna/blob/main/";

// Source file (path in the repository) → page slug on the site. Only these are published.
export const pages = {
  "Architecture.md": "concepts/architecture",
  "docs/bank.md": "features/bank",
  "docs/shares.md": "features/shares",
  "docs/recovery.md": "features/recovery",
  "docs/sealed-orders-testnet.md": "features/sealed-orders",
  "docs/sponsored-gas.md": "features/sponsored-gas",
  "docs/market.md": "features/market",
  "docs/registry.md": "features/registry",
  "docs/attacks.md": "security/attacks",
  "docs/rob-the-agent.md": "security/rob-the-agent",
  "docs/EVIDENCE.md": "security/evidence",
  "CLAIMS.md": "security/claims",
  "docs/api.md": "reference/api",
};

const imageExt = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const generatedDirs = [...new Set(Object.values(pages).map((slug) => slug.split("/")[0]))];

function toRepoPath(fromFile, target) {
  const abs = resolve(repo, dirname(fromFile), target);
  const rel = relative(repo, abs).split("\\").join("/");
  return rel.startsWith("..") ? null : normalize(rel).split("\\").join("/");
}

function rewriteTarget(fromFile, raw) {
  if (/^([a-z]+:|#|\/\/|mailto:)/i.test(raw)) return raw;
  const [path, anchor] = raw.split("#");
  if (!path) return raw;
  const repoPath = toRepoPath(fromFile, path);
  if (!repoPath) return raw;
  const hash = anchor ? `#${anchor}` : "";
  if (pages[repoPath]) return `/${pages[repoPath]}/${hash}`;
  if (imageExt.has(extname(repoPath).toLowerCase()) && existsSync(join(repo, repoPath))) {
    const out = join(mediaDir, repoPath);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(join(repo, repoPath), out);
    return `/media/${repoPath}`;
  }
  return `${github}${repoPath}${hash}`;
}

function rewriteLinks(fromFile, text) {
  // Leave fenced code blocks untouched.
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_, a, target, b) => a + rewriteTarget(fromFile, target) + b)
            .replace(/^(\[[^\]]+\]:\s*)(\S+)/gm, (_, a, target) => a + rewriteTarget(fromFile, target))
            .replace(/(<img[^>]*\ssrc=")([^"]+)(")/g, (_, a, target, b) => a + rewriteTarget(fromFile, target) + b),
    )
    .join("");
}

function plain(line) {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function convert(file) {
  const source = readFileSync(join(repo, file), "utf8").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const h1 = lines.findIndex((l) => /^# /.test(l));
  if (h1 === -1) throw new Error(`${file}: no "# Title" line`);
  const title = lines[h1].slice(2).trim();
  const body = lines.slice(h1 + 1).join("\n").replace(/^\n+/, "");
  const firstParagraph = body.split(/\n\s*\n/).find((p) => p.trim() && !/^(#|\||```|-|\*|\d+\.|<)/.test(p.trim()));
  const description = firstParagraph ? plain(firstParagraph.replace(/\n/g, " ")) : "";
  const front = [
    "---",
    `title: ${JSON.stringify(title)}`,
    description ? `description: ${JSON.stringify(description.length > 200 ? `${description.slice(0, 197)}...` : description)}` : null,
    "editUrl: " + JSON.stringify(`https://github.com/Euthyna-wallets/Euthyna/edit/main/${file}`),
    "---",
    "",
    `<!-- Generated from ${file} by docs-site/scripts/sync.mjs. Edit the source file, not this one. -->`,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  return front + rewriteLinks(file, body);
}

for (const dir of generatedDirs) rmSync(join(contentDir, dir), { recursive: true, force: true });
rmSync(mediaDir, { recursive: true, force: true });

for (const [file, slug] of Object.entries(pages)) {
  const out = join(contentDir, `${slug}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, convert(file));
}
console.log(`docs-site: ${Object.keys(pages).length} pages synced from the repository`);
