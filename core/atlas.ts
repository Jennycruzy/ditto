import * as z from "zod/v4";
import type { Address, Hex } from "viem";
import type { Chain } from "./chains.js";
import { usdcAddress } from "./chains.js";
import provenance from "./provenance.json" with { type: "json" };
import type { Family } from "./recipes/types.js";
import type { Rpc } from "./rpc.js";
import { addr, same, value } from "./recipes/shared.js";
import { ExecutionEngine } from "./execution/engine.js";
import { liveEvidence } from "./execution/evidence.js";
import type { Evidence, Target } from "./execution/types.js";
import { quote } from "./text.js";

// SPEC §13. One crawl per chain: known markets plus Morpho's own listing of the largest USDC vaults, each given
// live evidence (§13.1 steps 1-4) and a 1-unit dry run through the same checks a plan uses (step 5).
export const atlasChains: Chain[] = ["base", "arbitrum", "optimism", "ethereum"];
const lpPools: Record<string, { protocol: string; pool: string }[]> = {
  base: [{ protocol: "Uniswap v3", pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224" }, { protocol: "Aerodrome Slipstream", pool: "0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59" }],
};
const morphoChainId: Partial<Record<Chain, number>> = { base: 8453, arbitrum: 42161, optimism: 10 };
const listing = z.object({ data: z.object({ vaults: z.object({ items: z.array(z.object({ address: z.string(), name: z.string().max(200) })).max(20) }).nullable().optional(), vaultV2s: z.object({ items: z.array(z.object({ address: z.string(), name: z.string().max(200) })).max(20) }).nullable().optional() }) });
export async function morphoTopVaults(chain: Chain, fetcher: typeof fetch = fetch, first = 6) {
  const id = morphoChainId[chain]; if (!id) return [];
  const where = `where: { chainId_in: [${id}], assetAddress_in: ["${usdcAddress(chain as Exclude<Chain, "ethereum">)}"], listed: true }`;
  const query = `{ vaults(first: ${first}, orderBy: TotalAssetsUsd, orderDirection: Desc, ${where}) { items { address name } } vaultV2s(first: ${first}, orderBy: TotalAssetsUsd, orderDirection: Desc, ${where}) { items { address name } } }`;
  const r = await fetcher("https://api.morpho.org/graphql", { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(5000) });
  const data = listing.parse(JSON.parse((await r.text()).slice(0, 262144))).data;
  return [...(data.vaultV2s?.items ?? []), ...(data.vaults?.items ?? [])].filter(v => /^0x[0-9a-fA-F]{40}$/.test(v.address)).map(v => ({ address: addr(v.address), name: v.name }));
}
export async function atlasTargets(chain: Chain, fetcher: typeof fetch = fetch) {
  const out: (Target & { protocol: string })[] = [], failures: string[] = [];
  const add = (family: Family, contract: string, protocol: string) => { if (!out.some(t => same(t.contract, contract))) out.push({ chain, family, contract: addr(contract), protocol }); };
  if (chain !== "ethereum") { add("aave-v3", provenance.aave[chain].pool, "Aave v3"); add("compound-v3", provenance.compound[chain].comet, "Compound v3"); }
  if (chain === "base" || chain === "optimism") add("moonwell", provenance.moonwell[chain].market, "Moonwell");
  if (chain === "ethereum") add("lst", provenance.lido.steth, "Lido stETH");
  for (const v of provenance.namedVaults.filter(v => v.chain === chain)) add("erc4626", v.address, v.protocol);
  for (const p of lpPools[chain] ?? []) add("lp-v3", p.pool, p.protocol);
  try { for (const v of await morphoTopVaults(chain, fetcher)) add("erc4626", v.address, `Morpho: ${v.name}`); }
  catch { failures.push("Morpho vault listing unavailable; known markets only."); }
  return { targets: out, failures };
}
export type AtlasRow = {
  id: string; chain: Chain; family: Family; contract: Address; receiptToken: Address; protocol: ReturnType<typeof quote>;
  verdict: "ok" | "refused"; refusals: { code: string; reason: string }[]; checks: { code: string; pass: boolean; detail: string; blocking: boolean }[];
  exitClass: string; exitPreview: { block: string; returns: { token: string; amount: { atomic: string; display: string } }[]; pass: boolean; detail: string } | null;
  totalAssets: { atomic: string; display: string }; assetDecimals: number; apy7dPct: number | null;
  evidence: Evidence; rank: { score: number; why: string };
};
const sharePriceApy = (e: Evidence) => {
  const p = e.sharePrices; if (p.length < 2) return null;
  const a = BigInt(p[0]!.value), b = BigInt(p.at(-1)!.value), seconds = (Date.parse(p.at(-1)!.at) - Date.parse(p[0]!.at)) / 1000;
  if (a <= 0n || seconds <= 0) return null;
  return Math.round((Math.pow(Number(b * 10n ** 12n / a) / 1e12, 31_536_000 / seconds) - 1) * 10000) / 100;
};
// §13.3: most used today among those that pass every check; never by yield.
export function score(e: Evidence, ok: boolean, now: number) {
  if (!ok) return 0;
  const age = e.lastSeen ? (now - Date.parse(e.lastSeen)) / 3_600_000 : 24, recency = Math.max(0.25, 1 - age / 24);
  return Math.round(Math.log(1 + e.deposits24h) * Math.log(1 + e.uniqueWallets24h) * recency * 1000) / 1000;
}
export async function crawlChain(chain: Chain, rpc: Rpc, options: { now?: number; fetcher?: typeof fetch; limit?: number } = {}) {
  const now = options.now ?? Date.now(), started = performance.now();
  const { targets, failures } = await atlasTargets(chain, options.fetcher);
  const rows: AtlasRow[] = [];
  for (const t of targets.slice(0, options.limit ?? 16)) {
    try {
      let evidence: Evidence | undefined;
      const engine = new ExecutionEngine(rpc, { maxAmount: "1", now: () => now, evidence: async (i, r, b, n) => evidence = await liveEvidence(i, r, b, n) });
      const block = await rpc.call<Hex>("eth_blockNumber", []), i = await engine.identity(t, "0x000000000000000000000000000000000000d177", block);
      const dry = await engine.dryRun({ chain, family: t.family, contract: t.contract, amount: t.family === "lst" ? "0.01" : "1", ...(t.family === "lst" ? { acceptExit: "queued" } : t.family === "lp-v3" ? { acceptExit: "market" } : {}) }) as Record<string, any>;
      if (!evidence) evidence = await liveEvidence(i, rpc, block, now);
      const ok = dry.verdict === "ok", protocol = quote(t.protocol);
      const why = ok ? `${evidence.deposits24h} deposits by ${evidence.uniqueWallets24h} wallets in 24h; passed every check.` : `Refused: ${(dry.refusals ?? []).map((r: { reason: string }) => r.reason).join(" ")}`.slice(0, 500);
      rows.push({ id: `${chain}:${i.family}:${i.contract}`, chain, family: i.family, contract: i.contract, receiptToken: i.receiptToken, protocol, verdict: ok ? "ok" : "refused",
        refusals: (dry.refusals ?? []).map((r: { code: string; reason: string }) => ({ code: r.code, reason: r.reason })), checks: dry.checks ?? [],
        exitClass: i.family === "lst" ? "queued" : i.family === "lp-v3" ? "market" : "instant",
        exitPreview: dry.preview?.exitPreview ? { block: String(BigInt(dry.preview.exitPreview.block)), returns: dry.preview.exitPreview.returns, pass: dry.preview.exitPreview.pass, detail: dry.preview.exitPreview.detail } : null,
        totalAssets: value(i.totalAssets, i.assetDecimals), assetDecimals: i.assetDecimals, apy7dPct: sharePriceApy(evidence), evidence, rank: { score: score(evidence, ok, now), why } });
    } catch (error) { failures.push(`${t.protocol} ${t.contract}: ${String((error as Error).message).slice(0, 160)}`); }
  }
  rows.sort((a, b) => b.rank.score - a.rank.score || b.evidence.deposits24h - a.evidence.deposits24h);
  return { version: 1 as const, chain, generatedAt: new Date(now).toISOString(), durationMs: Math.round(performance.now() - started), rows, failures };
}
export type AtlasChain = Awaited<ReturnType<typeof crawlChain>>;
// Plugin side (§13.2): use the published atlas when under 2 h old, else the live fallback.
export function atlasEvidence(atlas: AtlasChain | undefined, contract: Address, now: number): Evidence | undefined {
  if (!atlas || now - Date.parse(atlas.generatedAt) > 7_200_000) return undefined;
  return atlas.rows.find(r => same(r.contract, contract))?.evidence;
}
