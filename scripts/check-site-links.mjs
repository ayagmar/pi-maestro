// Checks every internal href/src in a built site resolves to a file in it,
// under the GitHub Pages base path. Usage: node scripts/check-site-links.mjs dist
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BASE = "/pi-maestro";
const dist = process.argv[2] ?? "dist";

function resolves(path) {
  const target = join(dist, path.slice(BASE.length));
  if (!existsSync(target)) return false;
  return statSync(target).isFile() || existsSync(join(target, "index.html"));
}

const pages = readdirSync(dist, { recursive: true }).filter((file) => file.endsWith(".html"));
const problems = [];
for (const page of pages) {
  const html = readFileSync(join(dist, page), "utf-8");
  for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
    const [path = ""] = href.split("#");
    if (!path.startsWith(`${BASE}/`)) problems.push(`${page}: outside ${BASE}/: ${href}`);
    else if (!resolves(path)) problems.push(`${page}: missing target: ${href}`);
  }
}

for (const problem of problems) console.error(problem);
console.log(`${pages.length} pages, ${problems.length} broken internal links`);
if (pages.length === 0 || problems.length > 0) process.exit(1);
