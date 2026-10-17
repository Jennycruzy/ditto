import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { homedir } from "node:os";

let localKey;
try {
  const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
  localKey = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
} catch (error) { if (error.code !== "ENOENT") throw new Error("Could not run local credential check"); }
const artifacts = [];
for (const path of ["dist/core.mjs", "dist/browser.mjs", "plugin/dist/plugin.mjs"]) {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  if (bytes.length > 1_500_000 || (localKey && text.includes(localKey)) || /alchemy\.com\/v2\/[A-Za-z0-9_-]{10,}|Bearer [A-Za-z0-9_-]{16,}|sourceMappingURL=/.test(text)) throw new Error("Artifact check failed");
  try { await access(`${path}.map`); throw new Error("Unexpected source map"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (path === "dist/browser.mjs" && /node:crypto|createHmac|DITTO_PLAN_KEY/.test(text)) throw new Error("Signing code in browser artifact");
  artifacts.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
console.log(JSON.stringify({ status: "passed", credentialScan: localKey ? "local-and-pattern" : "pattern", browserSigningExcluded: true, artifacts }));
