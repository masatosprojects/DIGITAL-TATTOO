import { defineConfig } from "vite";

/**
 * Resolve Vite `base` for static same-origin deploy.
 *
 * - Default `./` — relative URLs work on domain roots (Netlify, custom domain)
 *   and many subdirectory hosts.
 * - On GitHub Actions, use `/<repo>/` so project Pages
 *   (`https://<user>.github.io/<repo>/`) resolve assets even without a
 *   trailing slash on the page URL.
 * - Override anytime: `VITE_BASE=/my-repo/` or `VITE_BASE=./`
 *
 * `public/models/` is copied into `dist/models/` on build.
 * Runtime never fetches Hugging Face / CDN; only same-origin models/.
 */
function resolveBase() {
  let base;
  if (process.env.VITE_BASE) {
    base = process.env.VITE_BASE;
  } else if (process.env.GITHUB_ACTIONS && process.env.GITHUB_REPOSITORY) {
    // Preserve repo case (DIGITAL-TATTOO) — Pages paths are case-sensitive.
    const repo = process.env.GITHUB_REPOSITORY.split("/")[1];
    base = repo ? `/${repo}/` : "./";
  } else {
    base = "./";
  }
  if (base !== "./" && base !== "." && !base.endsWith("/")) {
    base += "/";
  }
  return base;
}

export default defineConfig({
  base: resolveBase(),
  publicDir: "public",
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 7000,
    // Large WebLLM weight files under public/ are copied as-is (not bundled).
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    exclude: ["@mlc-ai/web-llm"],
  },
});
