import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { JsonRpc, explainTransaction, morphoQuery, parseMorphoListing, recognitionRpcBudgets, medianPositionWidth, morphoListing } from "../dist/core.mjs";
const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!key) throw new Error("Local credential missing");
const headers = { authorization: `Bearer ${key}` }, dest = new URL("../test/fixtures/recognition/", import.meta.url);
await mkdir(dest, { recursive: true });
let failures = 0; const report = [], samples = [];
const selected = process.argv.slice(2);
for (const name of (await readdir(new URL("../test/fixtures/receipts/", import.meta.url))).sort()) {
  if (selected.length && !selected.some(s => name.startsWith(s))) continue;
  await setTimeout(400);
  const f = JSON.parse(await readFile(new URL(`../test/fixtures/receipts/${name}`, import.meta.url), "utf8"));
  const now = Date.now(), calls = [], listings = [], client = new JsonRpc(f.chain, { headers, maxRequests: recognitionRpcBudgets.explain });
  const record = async (method, params) => {
    try { const result = await client.call(method, params); calls.push({ method, params, result }); return result; }
    catch (e) { calls.push({ method, params, error: e.reason ?? "unavailable" }); throw e; }
  };
  const rpc = { call: record, batch: async inputs => {
    try { const results = await client.batch(inputs); inputs.forEach((c, n) => calls.push({ ...c, result: results[n] })); return results; }
    catch(e) { inputs.forEach(c => calls.push({ ...c, error: e.reason ?? "unavailable" })); throw e; }
  } };
  const listing = async (address, chain) => {
    return morphoListing(address, chain, async (url, init) => {
      const r = await fetch(url, init); const body = await r.clone().json();
      listings.push({ address, chain, query: JSON.parse(init.body).query, body }); return r;
    }, now);
  };
  try {
    const output = await explainTransaction({ chain: f.chain, tx: f.tx.hash }, rpc, { now, listing });
    if (!output.actions.length) { await writeFile(`/tmp/ditto-recognition-${name}`, JSON.stringify({ output, calls, listings }, null, 2)); }
    assert(output.actions.length > 0, "No recognised actions");
    for (const a of f.expected) assert(output.actions.some(x => x.contract.toLowerCase() === a.contract.toLowerCase() && x.kind === a.kind && x.actor.toLowerCase() === a.actor.toLowerCase()), "Expected action missing");
    const block = await new JsonRpc(f.chain, { headers }).call("eth_getBlockByNumber", [f.receipt.blockNumber, false]);
    for (const a of output.actions.filter(a => a.family === "lp-v3" && a.kind === "enter")) {
      const position = Object.entries(f.context.lpPositions ?? {}).find(([key, p]) => key.endsWith(`:${a.tokenId}`) && p.pool.toLowerCase() === a.contract.toLowerCase())?.[1];
      if (position) samples.push({ chain: f.chain, pool: a.contract, txHash: a.txHash, tokenId: a.tokenId, tickLower: position.tickLower, tickUpper: position.tickUpper, amount0: a.lpPosition.amount0, amount1: a.lpPosition.amount1, at: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() });
    }
    const result = { rangeSamples: samples.filter(s => s.txHash === f.tx.hash), generatedAt: new Date(now).toISOString(), labels: ["OBSERVED"], name: name.replace(".json", ""), chain: f.chain, input: { chain: f.chain, tx: f.tx.hash }, rpc: calls, listings, expected: output };
    await writeFile(new URL(name, dest), JSON.stringify(result, null, 2) + "\n");
    report.push({ name, route: output.route, actions: output.actions.length, copyable: output.copyable, incomplete: output.ditto.incomplete, requests: client.usage.requests, durationMs: output.ditto.timingsMs.total });
    console.log(JSON.stringify(report.at(-1)));
  } catch(e) { failures++; console.error(JSON.stringify({ name, status: "failed", reason: e.reason ?? e.message?.slice(0, 150) })); }
}
const saved = await Promise.all((await readdir(dest)).filter(n => n.endsWith(".json")).map(async n => JSON.parse(await readFile(new URL(n, dest), "utf8"))));
const allSamples = saved.flatMap(f => f.rangeSamples ?? []);
const ranges = [...new Set(allSamples.map(s => `${s.chain}:${s.pool}`))].map(key => {
  const s = allSamples.find(s => `${s.chain}:${s.pool}` === key), newest = Math.max(...allSamples.filter(x => x.pool === s.pool && x.chain === s.chain).map(x => Date.parse(x.at)));
  return { chain: s.chain, pool: s.pool, asOf: new Date(newest).toISOString(), ...medianPositionWidth(allSamples, s.chain, s.pool, newest) };
});
await writeFile(new URL("../evidence/recognition-check.json", import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), labels: ["OBSERVED"], cases: saved.map(f => ({ name: f.name, capturedAt: f.generatedAt, route: f.expected.route, actions: f.expected.actions.length, copyable: f.expected.copyable, incomplete: f.expected.ditto.incomplete, durationMs: f.expected.ditto.timingsMs.total })), latestCaptureFailures: failures, moneySpent: "0" }, null, 2) + "\n");
await writeFile(new URL("../evidence/lp-ranges.json", import.meta.url), JSON.stringify({ labels: ["OBSERVED", "HISTORICAL"], samples: allSamples, ranges, detail: "Receipt samples with their actual timestamps. Recompute the median inside a fresh window before building a current plan." }, null, 2) + "\n");
if (failures) process.exitCode = 1;
