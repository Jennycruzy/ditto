import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { JsonRpc, walletMoves, recognitionRpcBudgets } from "../dist/core.mjs";
const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!key) throw new Error("Local credential missing");
const input = { chain: "base", wallet: "0x62cd77f1b851a1df9aaadcdcf49e107f887d4dd4", window: "30d", limit: 5 };
const client = new JsonRpc(input.chain, { headers: { authorization: `Bearer ${key}` }, maxRequests: recognitionRpcBudgets.walletMoves }), calls = [];
const call = async (method, params) => {
  try { const result = await client.call(method, params); calls.push({ method, params, result }); return result; }
  catch (error) { calls.push({ method, params, error: error.reason ?? "unavailable" }); throw error; }
};
const rpc = { call, batch: async inputs => { const result = await client.batch(inputs); inputs.forEach((c,n) => calls.push({ ...c, result: result[n] })); return result; } };
const now = Date.now(), output = await walletMoves(input, rpc, { now, maxPages: 4 });
assert(output.scannedTransactions > 0, "No historical wallet transactions inspected");
assert(output.moves.some(m => m.family === "aave-v3"), "Expected completed Aave activity missing");
await mkdir(new URL("../test/fixtures/history/", import.meta.url), { recursive: true });
await writeFile(new URL("../test/fixtures/history/test-wallet-base.json", import.meta.url), JSON.stringify({ generatedAt: new Date(now).toISOString(), labels: ["OBSERVED"], input, rpc: calls, expected: output }, null, 2) + "\n");
console.log(JSON.stringify({ status: "passed", requests: client.usage.requests, pages: output.pages, moves: output.moves.length, incomplete: output.ditto.incomplete, durationMs: output.ditto.timingsMs.total, moneySpent: "0" }));
