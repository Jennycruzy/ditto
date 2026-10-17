import * as z from "zod/v4";
import type { Address, Hex } from "viem";
import type { Chain } from "./chains.js";
import { usdcAddress } from "./chains.js";
import type { Identity, Family } from "./recipes/types.js";
import type { Rpc } from "./rpc.js";
import { normalizedIncomeFragment } from "./recipes/index.js";
import { f, read, same } from "./recipes/shared.js";
import { windowStart } from "./recognise/wallet.js";
import { quote } from "./text.js";

// SPEC §12.6. Adapters are written from the real paid bodies in test/fixtures/opinions (captured 17 Oct, R10).
// OBSERVED 17 Oct: both Otto endpoints rejected PayBox's x402 payment proof with HTTP 402 (nothing settled), so they
// stay disabled until a paid capture succeeds. Pulse is x402 v1; PayBox's gateway paid it successfully (A15 passed).
export type SourceId = "mi-usdc" | "pulse-vaults" | "otto-markets" | "otto-recs";
export type Source = { id: SourceId; name: string; url: string; price: bigint; version: 1 | 2; enabled: boolean; disabledReason?: string; covers: (chain: Chain, family: Family, contract: Address) => boolean };
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// The six largest MetaMorpho USDC vaults Pulse returned in its paid capture; its custom-vault query is undocumented,
// so Ditto never guesses one and other vaults are not covered.
const pulseVaults = ["0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A", "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca", "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", "0x616a4E1db48e22028f6bbf20444Cd3b8e3273738", "0xE1bA476304255353aEF290e6474A417D06e7b773", "0x236919F11ff9eA9550A4287696C2FC9e18E6e890"];
export const sources: Source[] = [
  { id: "mi-usdc", name: "Market Intelligence API (USDC yield)", url: "https://api.marketintelligenceapi.com/api/v1/markets/usdc-yield", price: 2000n, version: 2, enabled: true,
    covers: (_chain, family) => family === "aave-v3" || family === "compound-v3" },
  { id: "pulse-vaults", name: "OnchainPulse (Base vault APY)", url: "https://onchainpulse.theaslangroupllc.com/api/vault-apy", price: 20000n, version: 1, enabled: true,
    covers: (chain, family, contract) => chain === "base" && (["aave-v3", "compound-v3", "moonwell"].includes(family) || (family === "erc4626" && pulseVaults.some(v => same(v, contract)))) },
  { id: "otto-markets", name: "Otto yield markets", url: "https://x402.ottoai.services/yield-markets", price: 1000n, version: 2, enabled: false, disabledReason: "OBSERVED 17 Oct: rejected PayBox's x402 payment proof (HTTP 402).", covers: () => false },
  { id: "otto-recs", name: "Otto yield recommendations", url: "https://x402.ottoai.services/yield-recommendations", price: 1000n, version: 2, enabled: false, disabledReason: "OBSERVED 17 Oct: rejected PayBox's x402 payment proof (HTTP 402).", covers: () => false },
];
export const HARD_MAX_PRICE = 50000n; // $0.05 in USDC atomic units
export function chooseSource(chain: Chain, family: Family, contract: Address, requested: SourceId | "auto" = "auto") {
  const enabled = sources.filter(s => s.enabled && (requested === "auto" || s.id === requested));
  if (requested !== "auto" && !enabled.length) throw new Error(`SOURCE_DOWN: ${sources.find(s => s.id === requested)?.disabledReason ?? "unknown source"}`);
  const covering = enabled.filter(s => s.covers(chain, family, contract)).sort((a, b) => a.price < b.price ? -1 : 1);
  if (!covering.length) throw new Error("SOURCE_NOT_COVERING");
  return covering[0]!;
}
// Read the live 402 challenge without paying. v2 carries it in the PAYMENT-REQUIRED header (base64 JSON, mirrored in
// some bodies); v1 carries accepts[] in the body with network "base" and maxAmountRequired.
const acceptV2 = z.object({ scheme: z.literal("exact"), network: z.string(), amount: z.string().regex(/^[1-9][0-9]{0,19}$/), asset: z.string(), payTo: z.string() }).passthrough();
const acceptV1 = z.object({ scheme: z.literal("exact"), network: z.string(), maxAmountRequired: z.string().regex(/^[1-9][0-9]{0,19}$/), asset: z.string(), payTo: z.string() }).passthrough();
export function parseChallenge(version: 1 | 2, status: number, header: string | null, body: unknown) {
  if (status !== 402) throw new Error(`SOURCE_DOWN: expected HTTP 402, got ${status}`);
  let raw: unknown = body;
  if (version === 2 && header) { try { raw = JSON.parse(atob(header)); } catch { throw new Error("SOURCE_DOWN: unreadable payment challenge"); } }
  const accepts = z.object({ accepts: z.array(z.unknown()).min(1).max(16) }).passthrough().safeParse(raw);
  if (!accepts.success) throw new Error("SOURCE_DOWN: no payment terms in the challenge");
  for (const a of accepts.data.accepts) {
    const v = version === 2 ? acceptV2.safeParse(a) : acceptV1.safeParse(a);
    if (!v.success) continue;
    const network = v.data.network, amount = BigInt("amount" in v.data ? v.data.amount as string : (v.data as { maxAmountRequired: string }).maxAmountRequired);
    if ((network === "eip155:8453" || network === "base") && same(v.data.asset, BASE_USDC) && !("extra" in v.data && (v.data.extra as { assetTransferMethod?: string })?.assetTransferMethod === "permit2")) return { amount, payTo: v.data.payTo };
  }
  throw new Error("SOURCE_DOWN: the challenge offers no USDC-on-Base exact payment");
}
export async function probeSource(source: Source, fetcher: typeof fetch = fetch) {
  const r = await fetcher(source.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(1500) });
  const text = (await r.text()).slice(0, 131072);
  let body: unknown = null; try { body = JSON.parse(text.slice(Math.max(0, text.indexOf("{")))); } catch { /* A header-only challenge is valid for v2. */ }
  return parseChallenge(source.version, r.status, r.headers.get("payment-required"), body);
}
// Adapters: only the fields Ditto compares, matched by contract address (never by name). Strings are untrusted.
const miRow = z.object({ protocol: z.string().max(40), chain: z.string().max(40), supplyApyPercent: z.number().finite(), totalSuppliedUsd: z.number().finite().nonnegative(), status: z.string().max(40), assetAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/), market: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).passthrough();
const miBody = z.object({ markets: z.array(z.unknown()).max(500), refreshedAt: z.string().max(64) }).passthrough();
const pulseMarket = z.object({ protocol: z.string().max(40), asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/), supply_apy_pct: z.number().finite(), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).passthrough();
const pulseVault = z.object({ vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/), name: z.string().max(200), asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/), total_assets_underlying: z.number().finite().nonnegative(), trailing_apy_pct: z.number().finite(), window_days: z.number().int().positive() }).passthrough();
const pulseBody = z.object({ chain: z.literal("base"), as_of_block: z.number().int().positive(), lending_markets: z.array(z.unknown()).max(100), erc4626_vaults: z.array(z.unknown()).max(100), generated_at: z.string().max(64) }).passthrough();
export type OpinionRow = { contract: Address; apyPct: number; sizeUsd: number | null; label: ReturnType<typeof quote>; status?: string; asOf: string };
const miChains: Record<Chain, string> = { base: "base", arbitrum: "arbitrum", optimism: "optimism", ethereum: "ethereum" };
const usdcFor = (chain: Chain) => chain === "ethereum" ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" : usdcAddress(chain);
export function adaptOpinion(source: SourceId, body: unknown, i: Identity): OpinionRow | null {
  if (source === "mi-usdc") {
    const b = miBody.safeParse(body); if (!b.success) throw new Error("SOURCE_FORMAT: response does not match the captured Market Intelligence shape");
    const protocol = i.family === "aave-v3" ? "aave_v3" : i.family === "compound-v3" ? "compound_v3" : null;
    for (const raw of b.data.markets) {
      const r = miRow.safeParse(raw); if (!r.success) continue;
      if (r.data.protocol === protocol && r.data.chain === miChains[i.chain] && same(r.data.market, i.contract) && same(r.data.assetAddress, usdcFor(i.chain))) return { contract: i.contract, apyPct: r.data.supplyApyPercent, sizeUsd: r.data.totalSuppliedUsd, label: quote(`${r.data.protocol} ${r.data.chain}`), status: quote(r.data.status).text, asOf: b.data.refreshedAt };
    }
    return null;
  }
  if (source === "pulse-vaults") {
    const b = pulseBody.safeParse(body); if (!b.success) throw new Error("SOURCE_FORMAT: response does not match the captured OnchainPulse shape");
    if (i.family === "erc4626") for (const raw of b.data.erc4626_vaults) {
      const v = pulseVault.safeParse(raw); if (!v.success) continue;
      if (same(v.data.vault, i.contract) && same(v.data.asset, BASE_USDC)) return { contract: i.contract, apyPct: v.data.trailing_apy_pct, sizeUsd: v.data.total_assets_underlying, label: quote(v.data.name), asOf: b.data.generated_at };
    }
    else for (const raw of b.data.lending_markets) {
      const m = pulseMarket.safeParse(raw); if (!m.success) continue;
      if (same(m.data.address, i.contract) && same(m.data.asset, BASE_USDC)) return { contract: i.contract, apyPct: m.data.supply_apy_pct, sizeUsd: null, label: quote(m.data.protocol), asOf: b.data.generated_at };
    }
    return null;
  }
  throw new Error("SOURCE_DOWN: this source is disabled");
}
// Ditto's own numbers, read onchain now: 7-day realised APY from share price (ERC-4626) or Aave's liquidity index;
// the current per-second supply rate for Comet and Moonwell (they have no share-price index). Size from totalAssets.
const annualise = (ratio: number, seconds: number) => (Math.pow(ratio, 31_536_000 / seconds) - 1) * 100;
export async function dittoNumbers(i: Identity, rpc: Rpc, block: Hex) {
  const sizeUsd = i.asset !== "native" && i.assetDecimals === 6 ? Number(BigInt(i.totalAssets)) / 1e6 : null;
  if (i.family === "compound-v3") {
    const utilization = await read(rpc, i.contract, "function getUtilization() view returns (uint256)", [], block) as bigint;
    const rate = await read(rpc, i.contract, "function getSupplyRate(uint256) view returns (uint64)", [utilization], block) as bigint;
    return { apyPct: annualise(1 + Number(rate) / 1e18, 1), method: "Comet current supply rate, per-second compounding", sizeUsd };
  }
  if (i.family === "moonwell") {
    const rate = await read(rpc, i.contract, "function supplyRatePerTimestamp() view returns (uint256)", [], block) as bigint;
    return { apyPct: (Math.pow(1 + Number(rate) * 86400 / 1e18, 365) - 1) * 100, method: "mToken supplyRatePerTimestamp, daily compounding", sizeUsd };
  }
  if (i.family !== "aave-v3" && i.family !== "erc4626") throw new Error("SOURCE_NOT_COVERING: Ditto has no comparable yield reading for this family");
  const head = await rpc.call<{ number: Hex; timestamp: Hex }>("eth_getBlockByNumber", [block, false]);
  const past = await windowStart(rpc, head, BigInt(head.timestamp) - 7n * 86400n, i.chain);
  const then = await rpc.call<{ timestamp: Hex }>("eth_getBlockByNumber", [past, false]);
  const reading = (b: Hex) => i.family === "aave-v3" ? read(rpc, i.contract, normalizedIncomeFragment, [i.asset], b) : read(rpc, i.contract, f.convert, [10n ** BigInt(i.receiptDecimals)], b);
  const [now, before] = await Promise.all([reading(block), reading(past)]) as [bigint, bigint];
  const seconds = Number(BigInt(head.timestamp) - BigInt(then.timestamp));
  if (before <= 0n || seconds <= 0) throw new Error("RPC_UNAVAILABLE: no 7-day reading");
  return { apyPct: annualise(Number(now * 10n ** 12n / before) / 1e12, seconds), method: i.family === "aave-v3" ? "Aave liquidity-index growth over 7 days" : "ERC-4626 share-price growth over 7 days", sizeUsd };
}
export function compareOpinion(row: OpinionRow | null, ditto: { apyPct: number; sizeUsd: number | null }) {
  if (!row) return { verdict: "not_listed" as const, apyAgrees: null, sizeAgrees: null };
  const apyAgrees = Math.abs(row.apyPct - ditto.apyPct) <= 1 || Math.abs(row.apyPct - ditto.apyPct) <= Math.abs(ditto.apyPct) * 0.2;
  const sizeAgrees = row.sizeUsd === null || ditto.sizeUsd === null ? null : Math.abs(row.sizeUsd - ditto.sizeUsd) <= ditto.sizeUsd * 0.1;
  return { verdict: apyAgrees && sizeAgrees !== false ? "agrees" as const : "disagrees" as const, apyAgrees, sizeAgrees };
}
export const usd = (atomic: bigint) => (Number(atomic) / 1e6).toFixed(atomic < 10000n ? 3 : 2);
