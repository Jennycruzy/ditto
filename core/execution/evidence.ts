import { toHex, type Hex } from "viem";
import { recipes, normalizedIncomeFragment } from "../recipes/index.js";
import { call, f, read, same, ZERO } from "../recipes/shared.js";
import { windowStart } from "../recognise/wallet.js";
import { discoverReceipt } from "../recognise/discover.js";
import { decodeReceipt } from "../recognise/decode.js";
import type { Evidence, EvidenceSource } from "./types.js";
// Live fallback is bounded and counts verified events, never inferred deposits
// from a wallet balance or a token's symbol. Counts are observed lower bounds.
export const liveEvidence: EvidenceSource = async (i, rpc, block, now) => {
  const head = await rpc.call<{ number: Hex; timestamp: Hex }>("eth_getBlockByNumber", [block, false]);
  const endTime = BigInt(head.timestamp), start = await windowStart(rpc, head, endTime - 86400n, i.chain);
  const filter = i.family === "lp-v3" ? { contractAddresses: [i.receiptToken], fromAddress: ZERO, category: ["erc721"] } : { contractAddresses: [i.receiptToken], category: ["erc20"] };
  const [recent, first] = await rpc.batch<{ transfers: { hash: Hex; blockNum: Hex; metadata: { blockTimestamp: string } }[]; pageKey?: string }>([
    { method: "alchemy_getAssetTransfers", params: [{ ...filter, fromBlock: start, toBlock: block, withMetadata: true, excludeZeroValue: true, maxCount: "0x40", order: "desc" }] },
    { method: "alchemy_getAssetTransfers", params: [{ ...(i.family === "lp-v3" ? { toAddress: i.contract, contractAddresses: [i.asset], category: ["erc20"] } : filter), fromBlock: "0x0", toBlock: block, withMetadata: true, excludeZeroValue: true, maxCount: "0x1", order: "asc" }] },
  ]);
  const e: Evidence = { chain: i.chain, contract: i.contract, generatedAt: new Date(now).toISOString(), deposits24h: 0, uniqueWallets24h: 0, firstSeen: first!.transfers[0]?.metadata?.blockTimestamp ?? new Date(now).toISOString(), sharePrices: [], lpRanges: [], volume24hUsd: "0", incomplete: false };
  const hashes = [...new Set(recent!.transfers.filter(t => Date.parse(t.metadata?.blockTimestamp) >= Number(endTime - 86400n) * 1000).map(t => t.hash))].slice(0, 20), wallets = new Set<string>();
  const rows = await Promise.all(hashes.map(async hash => {
    try {
      const receipt = await rpc.call<import("../recipes/types.js").Receipt>("eth_getTransactionReceipt", [hash]);
      const context = i.family === "lp-v3" ? (await discoverReceipt(i.chain, receipt, rpc, { listing: async () => undefined })).context : { chain: i.chain, identities: [i] };
      const actions = recipes[i.family]!.recognise(receipt, context).filter(a => a.kind === "enter" && same(a.contract, i.contract));
      let ranges: Evidence["lpRanges"] = [];
      if (i.family === "lp-v3") {
        const tx = await rpc.call("eth_getTransactionByHash", [hash]), decoded = decodeReceipt(i.chain, tx, receipt, context, { now });
        ranges = decoded.actions.filter(a => a.kind === "enter" && a.copyable === "yes" && a.lpPosition && same(a.contract, i.contract)).map(a => ({ chain: i.chain, pool: i.contract, txHash: hash, tokenId: a.tokenId!, tickLower: a.lpPosition!.tickLower, tickUpper: a.lpPosition!.tickUpper, amount0: a.lpPosition!.amount0, amount1: a.lpPosition!.amount1, at: recent!.transfers.find(t => same(t.hash, hash))!.metadata.blockTimestamp }));
      }
      const at = recent!.transfers.find(t => same(t.hash, hash))?.metadata?.blockTimestamp;
      return { actions, ranges, hash, at, direct: same(receipt.to ?? ZERO, i.contract) };
    } catch { e.incomplete = true; return { actions: [], ranges: [], hash, at: undefined, direct: false }; }
  }));
  e.sampleTxs = []; e.directDeposits = 0;
  for (const row of rows) {
    for (const a of row.actions) { e.deposits24h++; wallets.add(a.actor.toLowerCase()); e.volume24hUsd = (BigInt(e.volume24hUsd) + BigInt(a.amount)).toString(); if (row.direct) e.directDeposits++; }
    if (row.actions.length && e.sampleTxs.length < 3) e.sampleTxs.push(row.hash);
    if (row.actions.length && row.at && (!e.lastSeen || row.at > e.lastSeen)) e.lastSeen = row.at;
    e.lpRanges.push(...row.ranges);
  }
  e.uniqueWallets24h = wallets.size;
  if (i.family === "erc4626" || i.family === "aave-v3") {
    // One exact lookup for 7 days ago, then daily blocks interpolated between it and now: two batched reads in total.
    const first = BigInt(await windowStart(rpc, head, endTime - 7n * 86400n, i.chain)), last = BigInt(block);
    const blocks = Array.from({ length: 8 }, (_, n) => toHex(n === 7 ? last : first + (last - first) * BigInt(n) / 7n));
    const heads = await rpc.batch<{ number: Hex; timestamp: Hex }>(blocks.map(b => ({ method: "eth_getBlockByNumber", params: [b, false] })));
    const prices = await rpc.batch<Hex>(blocks.map(b => call(i.contract, i.family === "aave-v3" ? normalizedIncomeFragment : f.convert, [i.family === "aave-v3" ? i.asset : 10n ** BigInt(i.receiptDecimals)], b)));
    e.sharePrices = blocks.map((b, n) => {
      if (BigInt(heads[n]!.number) !== BigInt(b)) throw new Error("RPC_UNAVAILABLE: wrong block returned");
      return { at: new Date(Number(BigInt(heads[n]!.timestamp)) * 1000).toISOString(), value: BigInt(prices[n]!).toString() };
    });
  }
  return e;
};
export function evidenceWithFallback(atlas: (chain: Evidence["chain"], contract: Evidence["contract"]) => Promise<Evidence | undefined>, fallback: EvidenceSource = liveEvidence): EvidenceSource {
  return async (i, rpc, block, now) => {
    try {
      const e = await atlas(i.chain, i.contract), age = e ? now - Date.parse(e.generatedAt) : Infinity;
      if (e && e.chain === i.chain && same(e.contract, i.contract) && age >= 0 && age < 7_200_000 && !e.incomplete) return e;
    } catch { /* Missing or stale atlas data must be replaced by fresh chain reads. */ }
    return fallback(i, rpc, block, now);
  };
}
