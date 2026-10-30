/**
 * A small markdown renderer for market reports. Reports come from sellers'
 * agents, so nothing is ever injected as HTML: text becomes React nodes, and
 * links are kept only for http(s) URLs (opened in a new tab, no referrer).
 */
import type { ReactNode } from "react";

function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Inline: `code`, **bold**, *italic*, [text](url) and bare URLs. */
export function inline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>\]]+)/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (match[2]) nodes.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    else if (match[3]) nodes.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);
    else if (match[4]) {
      const [, label, url] = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const href = safeUrl(url!);
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">{label}</a> : label);
    } else {
      const href = safeUrl(token);
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">{token}</a> : token);
    }
    last = match.index! + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${i}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i += 1;
      blocks.push(<pre key={key}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1]!.length + 1, 5);
      const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5";
      blocks.push(<Tag key={key}>{inline(heading[2]!, key)}</Tag>);
      i += 1;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push(
        <div key={key} className="md-table"><table>
          <thead><tr>{head.map((cell, c) => <th key={c}>{inline(cell, `${key}h${c}`)}</th>)}</tr></thead>
          <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell, `${key}r${r}c${c}`)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={key}>{items.map((item, n) => <li key={n}>{inline(item, `${key}l${n}`)}</li>)}</List>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(quote.join(" "), key)}</blockquote>);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i += 1;
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|>|\|)/.test(lines[i]!)) paragraph.push(lines[i++]!);
    if (paragraph.length === 0) paragraph.push(lines[i++]!);
    blocks.push(<p key={key}>{inline(paragraph.join(" "), key)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
