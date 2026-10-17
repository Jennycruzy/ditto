import { mkdir, writeFile } from "node:fs/promises";
import { JsonRpc } from "../core/rpc.js";
import { crawlChain } from "../core/atlas.js";
import type { Chain } from "../core/chains.js";
// Bundled to crawl.mjs and run by the public ditto-atlas repo's Actions with ALCHEMY_API_KEY as a secret.
// CU weights are ASSUMED from Alchemy's published per-method costs; the budget check uses them, not a measurement.
const cu: Record<string, number> = { eth_call: 26, eth_getBalance: 20, eth_blockNumber: 10, eth_gasPrice: 20, eth_estimateGas: 87, eth_getBlockByNumber: 16, eth_getTransactionReceipt: 20, eth_getTransactionByHash: 17, eth_getLogs: 75, eth_simulateV1: 100, alchemy_getAssetTransfers: 150 };
const key = process.env.ALCHEMY_API_KEY;
if (!key) throw new Error("ALCHEMY_API_KEY is not set");
const out = process.argv[2] ?? "out", interval = Number(process.env.ATLAS_INTERVAL_MINUTES ?? 30), started = Date.now();
await mkdir(out, { recursive: true });
let estimated = 0, active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
  active++;
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await work(); }
      catch (error) { if (attempt >= 3 || /reverted|invalid/i.test(String((error as Error).message))) throw error; await new Promise(r => setTimeout(r, 1500 * 2 ** attempt)); }
    }
  } finally { active--; waiting.shift()?.(); }
}
const meta = { version: 1, generatedAt: new Date(started).toISOString(), durationMs: 0, intervalMinutes: interval, cu: { estimated: 0, measured: null, budget: 12_000_000 }, counts: {} as Record<string, { sampled: number; recognised: number; rebuildable: number }>, failures: [] as { chain: Chain; reason: string }[] };
// Base every run; one other chain per run in rotation, so each is refreshed every 3 hours at an hourly schedule.
const hour = new Date(started).getUTCHours(), rotation: Chain[] = ["arbitrum", "optimism", "ethereum"];
const selected = (process.env.ATLAS_CHAINS?.split(",") as Chain[] | undefined) ?? ["base", rotation[hour % 3]!];
for (const chain of selected) {
  const client = () => new JsonRpc(chain, { headers: { authorization: `Bearer ${key}` }, maxRequests: 256 });
  const count = (method: string, n = 1) => { estimated += (cu[method] ?? 26) * n; };
  // Free-tier throughput is limited: at most 4 requests in flight, and up to 3 retries with backoff.
  const rpc = { call: async <T>(m: string, p: readonly unknown[]) => { count(m); return limited(() => client().call<T>(m, p)); }, batch: async <T>(c: readonly { method: string; params: readonly unknown[] }[]) => { c.forEach(x => count(x.method)); return limited(() => client().batch<T>(c)); } };
  try {
    const atlas = await crawlChain(chain, rpc, { now: started, limit: chain === "base" ? 12 : 6 });
    await writeFile(`${out}/${chain}.json`, JSON.stringify(atlas, (_, v) => typeof v === "bigint" ? v.toString() : v) + "\n");
    meta.counts[chain] = { sampled: atlas.rows.length, recognised: atlas.rows.reduce((s, r) => s + r.evidence.deposits24h, 0), rebuildable: atlas.rows.filter(r => r.verdict === "ok").length };
    for (const reason of atlas.failures) meta.failures.push({ chain, reason: reason.slice(0, 500) });
    console.log(JSON.stringify({ chain, rows: atlas.rows.length, ok: meta.counts[chain]!.rebuildable, failures: atlas.failures.length, ms: atlas.durationMs }));
  } catch (error) { meta.failures.push({ chain, reason: String((error as Error).message).slice(0, 500) }); }
}
meta.durationMs = Date.now() - started; meta.cu.estimated = estimated;
await writeFile(`${out}/meta.json`, JSON.stringify(meta, null, 2) + "\n");
console.log(JSON.stringify({ cuEstimated: estimated, monthlyAtInterval: Math.round(estimated * 43200 / interval), durationMs: meta.durationMs }));
