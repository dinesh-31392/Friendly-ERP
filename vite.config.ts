import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Honour a harness-assigned port. Vite ignores $PORT by default, so read it
// here — with autoPort in .claude/launch.json the launcher picks a free port
// and passes it via PORT, which lets this dev server coexist with another
// chat's server already holding 5173. Falls back to 5173 for a plain `npm run dev`.
const devPort = process.env.PORT ? Number(process.env.PORT) : 5173;

/**
 * The product name in the three places JavaScript cannot reach.
 *
 * `src/config/brand.ts` covers everything rendered by the app, and App.tsx sets
 * document.title from it. But three strings are read by the BROWSER, before or
 * independently of any script:
 *
 *   <title>                        shown before React mounts, and by crawlers
 *   apple-mobile-web-app-title     the iOS home-screen label, read at install
 *   manifest name / short_name     the Android and desktop install label
 *
 * Leaving them would mean a re-branded deployment whose tab still said the old
 * name for a moment and whose installed icon said it forever — which is the
 * "you missed one" failure this whole change exists to prevent. So they are
 * substituted at build time from the same variables.
 */
function brandStatics() {
  const name = process.env.VITE_BRAND_NAME || "Friendly ERP";
  const tagline = process.env.VITE_BRAND_TAGLINE || "Real Estate & Construction ERP";
  // Only the default is replaced, so a deployment that has already edited these
  // files by hand keeps its own wording.
  const swap = (s: string) =>
    s
      .split("Friendly ERP — Real Estate & Construction ERP").join(`${name} — ${tagline}`)
      .split("Friendly ERP - Real Estate & Construction ERP").join(`${name} - ${tagline}`)
      .split("Friendly ERP").join(name);

  return {
    name: "brand-statics",
    transformIndexHtml: { order: "pre" as const, handler: (html: string) => swap(html) },
    // The manifest lives in public/ and is copied verbatim, so it is rewritten
    // in the output rather than transformed on the way through.
    closeBundle() {
      const file = path.resolve(__dirname, "dist/manifest.webmanifest");
      if (!fs.existsSync(file)) return;
      fs.writeFileSync(file, swap(fs.readFileSync(file, "utf8")));
    },
  };
}

/**
 * Refuse to bake a filesystem path in as the API base.
 *
 * `VITE_API_URL=/ npm run build` is the documented command and the one CI runs.
 * Run it from Git Bash or MSYS on Windows and the shell rewrites the lone `/`
 * into the MSYS root before Node ever sees it, so the build embeds
 * `C:/Program Files/Git` and every request resolves to a file:// URL. The app
 * then loads, renders, and signs nobody in — the login POST goes to
 * `file:///C:/Program%20Files/Git/api/auth/login`, which the browser blocks.
 *
 * CI's existing guard cannot see this: it checks that the API machinery is
 * present, not that the value is usable, so a mangled build passes it. Caught
 * by serving a real dist and trying to log in.
 *
 * A valid base is empty (same-origin, what `/` becomes once trailing slashes
 * are stripped), a root-relative path, or an http(s) URL. Anything carrying a
 * drive letter or a file: scheme is a broken artifact, and failing here is much
 * cheaper than discovering it on the VPS.
 */
function assertUsableApiBase(): void {
  const raw = process.env.VITE_API_URL;
  if (raw === undefined || raw === "") return;
  const looksLikePath = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("file:");
  const looksLikeUrl = /^https?:\/\//.test(raw);
  const looksRootRelative = raw.startsWith("/");
  if (looksLikePath || !(looksLikeUrl || looksRootRelative)) {
    throw new Error(
      `VITE_API_URL is not a usable API base: ${JSON.stringify(raw)}\n` +
      `  Expected "/" (same-origin) or an http(s) URL.\n` +
      `  On Git Bash / MSYS the shell rewrites a lone "/" into the MSYS root — ` +
      `prefix the command with MSYS_NO_PATHCONV=1, or build from PowerShell.`,
    );
  }
}
assertUsableApiBase();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), brandStatics(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  // Proxy /api to the local API so the dev server is SAME-ORIGIN, exactly like
  // production (where nginx does this). Without it, dev had to point
  // VITE_API_URL at http://localhost:4000, which makes every call cross-origin
  // and puts CORS — a thing production never exercises — in the path of local
  // development. It also breaks in any browser or preview pane that will not
  // reach a second localhost port.
  //
  // API_PORT lets this follow a server started somewhere other than 4000.
  server: {
    port: devPort,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT || 4000}`,
        changeOrigin: true,
      },
    },
  },
  preview: { port: process.env.PORT ? Number(process.env.PORT) : 4173 },
});
