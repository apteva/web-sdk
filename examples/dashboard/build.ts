import { $ } from "bun";
import { rmSync, mkdirSync } from "fs";

rmSync("./dist", { recursive: true, force: true });
mkdirSync("./dist", { recursive: true });

// Runtime config baked at build time.
//   API_BASE     — base URL of apteva-server (default: same-origin)
//   TABLES_APP   — tables sidecar slug (default: "tables")
//   LEADS_TABLE  — name of the table holding lead rows (default: "leads")
const API_BASE = process.env.API_BASE || "";
const TABLES_APP = process.env.TABLES_APP || "tables";
const LEADS_TABLE = process.env.LEADS_TABLE || "leads";

console.log("Building CSS...");
await $`bunx @tailwindcss/cli -i ./src/index.css -o ./dist/style.css --minify`.quiet();

console.log(`Building JS... (API_BASE=${API_BASE || "<same-origin>"}, TABLES=${TABLES_APP}, LEADS_TABLE=${LEADS_TABLE})`);

const result = await Bun.build({
  entrypoints: ["./src/main.tsx"],
  outdir: "./dist",
  target: "browser",
  minify: true,
  sourcemap: "linked",
  define: {
    __API_BASE__: JSON.stringify(API_BASE),
    __TABLES_APP__: JSON.stringify(TABLES_APP),
    __LEADS_TABLE__: JSON.stringify(LEADS_TABLE),
  },
  naming: {
    entry: "[name]-[hash].[ext]",
    chunk: "[name]-[hash].[ext]",
    asset: "[name]-[hash].[ext]",
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const jsOutput = result.outputs.find((o) => o.path.endsWith(".js"));
const jsFile = jsOutput ? jsOutput.path.split("/").pop() : "main.js";

const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <title>Apteva Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./${jsFile}"></script>
  </body>
</html>`;

await Bun.write("./dist/index.html", html);

console.log("\nBuild complete:");
for (const output of result.outputs) {
  const size = (output.size / 1024).toFixed(1);
  console.log(`  ${output.path.split("/").pop()} (${size} KB)`);
}
console.log("  style.css");
console.log("  index.html");
