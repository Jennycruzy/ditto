import { build } from "esbuild";

await build({ entryPoints: ["core/index.ts"], bundle: true, platform: "node", format: "esm", target: "node24", minify: true, outfile: "dist/core.mjs", logLevel: "info" });
await build({ entryPoints: ["core/browser.ts"], bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true, outfile: "dist/browser.mjs", logLevel: "info" });
await build({ entryPoints: ["atlas/crawl.ts"], bundle: true, platform: "node", format: "esm", target: "node24", minify: true, outfile: "dist/crawl.mjs", logLevel: "info" });
