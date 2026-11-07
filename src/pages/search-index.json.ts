import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docs } from "../data/docs.js";

/** GitHub-style heading anchor, matching the ids Astro puts on rendered headings. */
function anchor(text: string, seen: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

const plain = (markdown: string) =>
  markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** One entry per H2 section of every documentation page. */
export function GET() {
  const entries = docs.flatMap((doc) => {
    const seen = new Map<string, number>();
    const sections: { heading: string; anchor: string; text: string[] }[] = [
      { heading: "", anchor: "", text: [] },
    ];
    let fenced = false;
    for (const line of readFileSync(join(process.cwd(), doc.file), "utf-8").split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      const heading = !fenced && /^(#{1,3}) (.+)$/.exec(line);
      if (heading) {
        const text = plain(heading[2] ?? "");
        const id = anchor(text, seen);
        if (heading[1] === "##") sections.push({ heading: text, anchor: id, text: [] });
        continue;
      }
      sections.at(-1)?.text.push(line);
    }
    return sections
      .map((section) => ({
        slug: doc.slug,
        page: doc.title,
        group: doc.group,
        heading: section.heading,
        anchor: section.anchor,
        text: plain(section.text.join(" ")).slice(0, 1_500),
      }))
      .filter((entry) => entry.heading || entry.text);
  });
  return new Response(JSON.stringify(entries), {
    headers: { "Content-Type": "application/json" },
  });
}
