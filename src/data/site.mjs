/**
 * The site lives under a base path on GitHub Pages
 * (https://ayagmar.github.io/pi-maestro/). Every internal link goes through
 * `url()` so the base is configured in one place: astro.config.mjs.
 */
const base = import.meta.env.BASE_URL.replace(/\/$/, "");

/** A root-relative site path ("/docs/") with the deployment base prefixed. */
export function url(path) {
  return `${base}${path}`;
}
