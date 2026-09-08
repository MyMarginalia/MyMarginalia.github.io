import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "path";

const require = createRequire(import.meta.url);
const STANDARD_FONTS_DIR = path.join(
  path.dirname(require.resolve("pdfjs-dist/package.json")),
  "standard_fonts",
);
const STANDARD_FONTS_ROUTE = "/pdfjs/standard_fonts/";

/**
 * Serves pdf.js's standard font data alongside the app.
 *
 * Without it pdf.js can't build the metrics for the 14 standard PDF fonts
 * (Times, Helvetica, Courier and friends) and falls back to a generic
 * sans-serif for the invisible text layer it lays over the rendered page. It
 * stretches each run horizontally so the ends still line up, but the
 * characters in between land wherever the substitute font's widths put them —
 * which is what makes a click place the caret beside the character you aimed
 * at. It's also the "Ensure that the standardFontDataUrl API parameter is
 * provided" warning pdf.js emits.
 *
 * Copied from the installed package rather than committed, so it can't drift
 * from the pdfjs-dist version actually in use.
 */
function pdfjsStandardFonts(): Plugin {
  return {
    name: "pdfjs-standard-fonts",
    configureServer(server) {
      server.middlewares.use(STANDARD_FONTS_ROUTE, (req, res, next) => {
        const name = path.basename(req.url ?? "");
        const file = path.join(STANDARD_FONTS_DIR, name);
        if (!name || !file.startsWith(STANDARD_FONTS_DIR) || !fs.existsSync(file)) {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const name of fs.readdirSync(STANDARD_FONTS_DIR)) {
        this.emitFile({
          type: "asset",
          fileName: `pdfjs/standard_fonts/${name}`,
          source: fs.readFileSync(path.join(STANDARD_FONTS_DIR, name)),
        });
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      quoteStyle: "double",
    }),
    react(),
    tailwindcss(),
    pdfjsStandardFonts(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Absolute root path — this deploys as MyMarginalia.github.io (a root org
  // page, not a project page under a subpath). A relative base ("./") looks
  // fine at "/", but breaks on refresh/direct-load of any nested route: GitHub
  // Pages serves the same 404.html content at every unmatched path, and a
  // relative asset reference in it then resolves relative to that path's
  // depth (e.g. "/read/abc123/assets/...") instead of the real asset location.
  base: "/",
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
