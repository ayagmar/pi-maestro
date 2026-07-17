import { docs } from "../data/docs.js";

const pages = ["/", "/docs/", ...docs.map((doc) => `/docs/${doc.slug}/`)];

export function GET() {
  const urls = pages
    .map((page) => `  <url><loc>https://pi-maestro.dev${page}</loc></url>`)
    .join("\n");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`,
    {
      headers: { "Content-Type": "application/xml" },
    }
  );
}
