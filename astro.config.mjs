import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://pi-maestro.dev",
  build: { format: "directory" },
  prefetch: true,
});
