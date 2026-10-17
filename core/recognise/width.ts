import type { Address } from "viem";
import type { Chain } from "../chains.js";
export type RangeSample = { chain: Chain; pool: Address; txHash: string; tokenId: string; tickLower: number; tickUpper: number; at: string };
// The median is calculated from unique, observed positions in this pool and window.
// No sample means no width: callers must not invent a default.
export function medianPositionWidth(samples: readonly RangeSample[], chain: Chain, pool: Address, now = Date.now(), windowMs = 86_400_000) {
  const seen = new Set<string>();
  const widths = samples.filter(s => {
    const age = now - Date.parse(s.at), key = `${s.txHash.toLowerCase()}:${s.tokenId}`;
    if (s.chain !== chain || s.pool.toLowerCase() !== pool.toLowerCase() || !Number.isFinite(age) || age < 0 || age > windowMs || seen.has(key) || !Number.isInteger(s.tickLower) || !Number.isInteger(s.tickUpper) || s.tickLower < -887272 || s.tickUpper > 887272 || s.tickUpper <= s.tickLower) return false;
    seen.add(key); return true;
  }).map(s => (s.tickUpper - s.tickLower) / 2).sort((a, b) => a - b);
  if (!widths.length) return null;
  const m = Math.floor(widths.length / 2);
  return { halfWidthTicks: Math.ceil(widths.length % 2 ? widths[m]! : (widths[m - 1]! + widths[m]!) / 2), samples: widths.length };
}
