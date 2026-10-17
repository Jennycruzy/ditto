import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { JsonRpc, ExecutionEngine, liveEvidence, ethUsdPrice } from "../dist/core.mjs";
const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!key) throw new Error("Local credential missing");
const headers = { authorization: `Bearer ${key}` }, calls = [];
// Evidence collection is a separate read-only crawl; each bounded RPC operation
// has its own deadline. Hosted per-tool timing is checked with cached evidence.
const rpc = { call: async (method, params) => { const result = await new JsonRpc("base", { headers, maxRequests: 128 }).call(method, params); calls.push({ method, params, result }); return result; }, batch: async inputs => { const values = await new JsonRpc("base", { headers, maxRequests: 128 }).batch(inputs); inputs.forEach((c, n) => calls.push({ ...c, result: values[n] })); return values; } };
let evidence;
const now = Date.now();
const engine = new ExecutionEngine(rpc, { now: () => now, maxAmount: "1", evidence: async (...args) => evidence = await liveEvidence(...args) });
const input = { chain: "base", family: "aave-v3", contract: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5", amount: "1" };
const output = await engine.dryRun(input);
await mkdir(new URL("../test/fixtures/execution/", import.meta.url), { recursive: true });
const result = { generatedAt: new Date(now).toISOString(), labels: ["OBSERVED", "SIMULATED"], input, rpc: calls, evidence, expected: output, moneySpent: "0" };
await writeFile(new URL("../test/fixtures/execution/aave-base-dry-run.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ verdict: output.verdict, refusals: output.refusals, requests: calls.length, checks: output.checks?.length, moneySpent: "0" }));
assert.equal(output.verdict, "ok"); assert(!output.plan); assert(!output.transaction);
