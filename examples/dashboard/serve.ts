// Tiny dev static server with sane cache headers for the build pipeline.
//
// Why this exists: `bunx serve dist` doesn't set Cache-Control, so
// browsers heuristic-cache index.html. When build.ts produces a fresh
// hashed JS bundle, the browser keeps using the cached index.html
// (which still points at the previous hash) and the UI never updates
// until you Cmd+Shift+R. This serve script:
//
//   - sends `Cache-Control: no-store` for index.html and anything
//     whose name doesn't carry a content hash, so reloads always pull
//     the latest index.
//   - sends `Cache-Control: public, max-age=31536000, immutable` for
//     hashed assets (main-<hash>.js, etc.) since the filename itself
//     is the cache key.
//   - SPA-falls-back unknown paths to index.html so client routing works.
//
// Run via `bun run serve` or directly: `bun run serve.ts [--port 5173]`.

import { stat } from "fs/promises";
import { join } from "path";

const DIST = new URL("./dist/", import.meta.url).pathname;

const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 5173;

// Hashed assets: name has at least one "-<8+ alphanumerics>." segment.
const HASHED = /-[a-z0-9]{6,}\.(?:js|css|mjs|map)$/i;

const server = Bun.serve({
  port: PORT,
  fetch: async (req) => {
    const url = new URL(req.url);
    let path = url.pathname;

    // Normalize "/" → "/index.html". For SPA-style deep links that
    // don't exist on disk, fall back to index.html so the React app's
    // own router can handle them.
    if (path === "/" || path.endsWith("/")) path = "/index.html";
    let filePath = join(DIST, path);
    let info: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      info = await stat(filePath);
      if (info.isDirectory()) throw new Error("dir");
    } catch {
      // SPA fallback — but only for paths that look like routes
      // (no extension). Asset misses stay as 404 so they surface fast.
      const last = path.split("/").pop() ?? "";
      if (!last.includes(".")) {
        filePath = join(DIST, "index.html");
        try {
          info = await stat(filePath);
        } catch {
          return new Response("not found", { status: 404 });
        }
      } else {
        return new Response("not found", { status: 404 });
      }
    }

    const file = Bun.file(filePath);
    const headers = new Headers();

    const base = filePath.split("/").pop() ?? "";
    if (HASHED.test(base)) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      // index.html, style.css (no hash), favicons, etc.
      headers.set("Cache-Control", "no-store, max-age=0, must-revalidate");
      headers.set("Pragma", "no-cache");
      headers.set("Expires", "0");
    }

    return new Response(file, { headers });
  },
});

console.log(`Serving dist/ on http://localhost:${server.port}`);
console.log("Cache: no-store for index.html, immutable for hashed assets");
