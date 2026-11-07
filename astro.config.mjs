import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://ayagmar.github.io",
  base: "/pi-maestro",
  trailingSlash: "always",
  build: { format: "directory" },
  prefetch: true,
  markdown: { syntaxHighlight: false },
});
