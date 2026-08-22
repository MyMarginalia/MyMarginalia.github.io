import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

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
