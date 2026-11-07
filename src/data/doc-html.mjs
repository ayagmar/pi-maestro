import { posix } from "node:path";

const REPOSITORY = "https://github.com/ayagmar/pi-maestro";
const ROOT_PAGES = new Set(["CHANGELOG", "CONTRIBUTING", "SECURITY"]);

/**
 * Where a repository path lands on the site. Files under docs/ and the three
 * root documents are site pages; everything else (README, LICENSE, examples)
 * points at the repository on GitHub.
 */
function siteHref(repositoryPath) {
  const page = /^docs\/([\w-]+)\.md$/.exec(repositoryPath)?.[1];
  if (page) return `/docs/${page}/`;
  const root = /^([A-Z]+)\.md$/.exec(repositoryPath)?.[1];
  if (root && ROOT_PAGES.has(root)) return `/docs/${root.toLowerCase()}/`;
  const route = /\.\w+$/.test(repositoryPath) ? "blob" : "tree";
  return `${REPOSITORY}/${route}/master/${repositoryPath.replace(/\/$/, "")}`;
}

/**
 * Turns the HTML Astro compiled from a repository markdown file into page
 * content: drops the file's own H1 (the layout renders the title), routes
 * relative links between files to site pages, and wraps tables so a wide one
 * scrolls inside the page and can be reached by keyboard.
 */
export function transformDocHtml(html, file) {
  const directory = posix.dirname(file);
  return html
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>\s*/, "")
    .replace(/<a href="([^"]*)"/g, (match, href) => {
      if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return match;
      const [target, fragment] = href.split("#");
      const resolved = posix.normalize(posix.join(directory, target));
      return `<a href="${siteHref(resolved)}${fragment ? `#${fragment}` : ""}"`;
    })
    .replace(
      /<table>/g,
      '<div class="table-scroll" role="region" aria-label="Table" tabindex="0"><table>'
    )
    .replace(/<\/table>/g, "</table></div>");
}
