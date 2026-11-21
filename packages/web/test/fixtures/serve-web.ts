// Serves the web surface with small page renderers, for the tests that look at what the surface
// serves: a feed page that follows the event stream, and a trace page that links every record of
// a chain to its own page.

import { serveWeb } from "../../src/index.ts";
import type { Chain, ChainRecord, WebOptions, WebServer } from "../../src/index.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function feedPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>niwa</title></head>
<body><script>new EventSource("/events");</script></body>
</html>
`;
}

function fields(value: unknown): string {
  if (value === null || typeof value !== "object") return escapeHtml(String(value ?? "-"));
  return `<dl>${Object.entries(value)
    .map(([name, field]) => `<dt>${escapeHtml(name)}</dt><dd>${fields(field)}</dd>`)
    .join("")}</dl>`;
}

function node(record: ChainRecord): string {
  const link = (id: string): string => `<a href="/trace/${encodeURIComponent(id)}">${escapeHtml(id)}</a>`;
  const cause = record.cause === null ? "none" : link(record.cause);
  return `<div><a href="/trace/${encodeURIComponent(record.id)}">${escapeHtml(record.type)}</a>
  <div>id ${escapeHtml(record.id)} by ${escapeHtml(record.actor)} cause ${cause} root ${link(record.root)}</div>
  ${fields(record.data)}</div>`;
}

function tracePage(recordId: string, chain: Chain): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>niwa ${escapeHtml(recordId)}</title></head>
<body>
<h1>trace of ${escapeHtml(recordId)}</h1>
<h2>What it depends on</h2>
${chain.causes.map(node).join("")}
<h2>What grew from it</h2>
${chain.trace.map(node).join("")}
</body>
</html>
`;
}

export function serveWebPages(options: Omit<WebOptions, "pages">): Promise<WebServer> {
  return serveWeb({ ...options, pages: { feed: feedPage, trace: tracePage } });
}
