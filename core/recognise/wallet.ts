import * as z from "zod/v4";
import { toHex, type Hex } from "viem";
import { hashSchema, addressSchema } from "../schemas.js";
import type { Rpc } from "../rpc.js";
import { quantity, walletMovesInputSchema, walletMovesSchema } from "./schemas.js";
import { explainTransaction } from "./service.js";
import type { DiscoveryOptions } from "./discover.js";

const blockSchema = z.object({ number: quantity, timestamp: quantity });
const pageSchema = z.object({ transfers: z.array(z.object({ hash: hashSchema, blockNum: quantity, from: addressSchema, to: addressSchema.nullable() })).max(100), pageKey: z.string().min(1).max(512).optional() });
// Use block timestamps, not an assumed average block time, for the history window.
export async function windowStart(rpc: Rpc, latest: Hex, cutoff: bigint) {
  let low = 0n, high = BigInt(latest);
  while (low < high) {
    const mid = (low + high) / 2n;
    const b = blockSchema.parse(await rpc.call("eth_getBlockByNumber", [toHex(mid), false]));
    if (BigInt(b.number) !== mid) throw new Error("RPC_UNAVAILABLE: wrong block returned");
    if (BigInt(b.timestamp) < cutoff) low = mid + 1n; else high = mid;
  }
  return toHex(low);
}
async function readWalletMoves(input: unknown, rpc: Rpc, options: DiscoveryOptions & { now?: number; maxPages?: number } = {}) {
  const started = performance.now(), args = walletMovesInputSchema.parse(input);
  const latest = blockSchema.parse(await rpc.call("eth_getBlockByNumber", ["latest", false]));
  const seconds = BigInt(args.window === "24h" ? 86400 : args.window === "7d" ? 604800 : 2592000);
  const cutoff = BigInt(latest.timestamp) > seconds ? BigInt(latest.timestamp) - seconds : 0n;
  const fromBlock = await windowStart(rpc, latest.number as Hex, cutoff);
  let incomplete = false, pages = 0;
  const failures: { txHash: string; reason: string }[] = [], hashes = new Map<string, string>();
  const maxPages = Math.min(12, options.maxPages ?? 4);
  const cursors: (string | undefined)[] = [undefined, undefined], done = [false, false], seen = [new Set<string>(), new Set<string>()];
  for (let n = 0; n < maxPages && !done.every(Boolean); n++) {
    for (let direction = 0; direction < 2; direction++) {
      if (done[direction]) continue;
      try {
        const raw = await rpc.call("alchemy_getAssetTransfers", [{ fromBlock, toBlock: latest.number, [direction === 0 ? "fromAddress" : "toAddress"]: args.wallet, category: ["external", "erc20", "erc721", ...(args.chain === "base" || args.chain === "optimism" ? [] : ["internal"])], withMetadata: true, excludeZeroValue: false, maxCount: "0x64", order: "desc", ...(cursors[direction] ? { pageKey: cursors[direction] } : {}) }]);
        const page = pageSchema.parse(raw); pages++;
        for (const t of page.transfers) {
          if (t.from.toLowerCase() !== args.wallet.toLowerCase() && t.to?.toLowerCase() !== args.wallet.toLowerCase()) throw new Error("Invalid wallet transfer response");
          if (BigInt(t.blockNum) >= BigInt(fromBlock) && BigInt(t.blockNum) <= BigInt(latest.number)) hashes.set(t.hash.toLowerCase(), t.blockNum);
        }
        if (!page.pageKey) done[direction] = true;
        else if (seen[direction]!.has(page.pageKey)) { incomplete = true; done[direction] = true; }
        else { seen[direction]!.add(page.pageKey); cursors[direction] = page.pageKey; }
      } catch { incomplete = true; done[direction] = true; }
    }
    if (hashes.size >= args.limit) { if (!done.every(Boolean)) incomplete = true; break; }
  }
  if (!done.every(Boolean)) incomplete = true;
  const candidates = [...hashes].sort((a, b) => BigInt(a[1]) === BigInt(b[1]) ? a[0].localeCompare(b[0]) : BigInt(a[1]) > BigInt(b[1]) ? -1 : 1);
  if (candidates.length > args.limit) incomplete = true;
  const moves = [], times = new Map<string, string>();
  for (const [hash, block] of candidates.slice(0, args.limit)) {
    try {
      const result = await explainTransaction({ chain: args.chain, tx: hash }, rpc, options);
      if (result.block !== BigInt(block).toString()) throw new Error("RPC_UNAVAILABLE: transfer and receipt blocks disagree");
      if (result.ditto.incomplete) incomplete = true;
      const actions = result.actions.filter(a => a.actor.toLowerCase() === args.wallet.toLowerCase() && a.kind !== "other");
      if (!actions.length) { failures.push({ txHash: hash, reason: result.reasons[0] ?? "UNRECOGNISED: no supported action credited to this wallet." }); continue; }
      if (!times.has(block)) {
        const b = blockSchema.parse(await rpc.call("eth_getBlockByNumber", [block, false]));
        if (b.number !== block) throw new Error("RPC_UNAVAILABLE: wrong history block");
        times.set(block, new Date(Number(BigInt(b.timestamp)) * 1000).toISOString());
      }
      moves.push(...actions.map(a => ({ ...a, time: times.get(block)! })));
    } catch { incomplete = true; failures.push({ txHash: hash, reason: "RPC_UNAVAILABLE: receipt or contract reads could not be completed." }); }
  }
  return walletMovesSchema.parse({ wallet: args.wallet, window: args.window, fromBlock: BigInt(fromBlock).toString(), toBlock: BigInt(latest.number).toString(), moves, notRecognised: { count: failures.length, reasons: failures }, scannedTransactions: Math.min(candidates.length, args.limit), pages, text: `Found ${moves.length} recognised wallet actions in ${args.window} from ${Math.min(candidates.length, args.limit)} inspected transactions. ${failures.length} transactions had no resolved supported action.${incomplete ? " PARTIAL: the page, transaction, or RPC budget was reached; this is not the wallet's complete history." : ""}`, ditto: { version: "0.1.0", chain: args.chain, generatedAt: new Date(options.now ?? Date.now()).toISOString(), timingsMs: { total: performance.now() - started }, labels: incomplete ? ["LIVE", "PARTIAL"] : ["LIVE"], incomplete, ...(incomplete ? { reason: "History is bounded; more pages or unresolved reads remain." } : {}) } });
}


export async function walletMoves(input: unknown, rpc: Rpc, options: DiscoveryOptions & { now?: number; maxPages?: number } = {}) {
  const args = walletMovesInputSchema.parse(input);
  try { return await readWalletMoves(args, rpc, options); }
  catch {
    return walletMovesSchema.parse({ wallet: args.wallet, window: args.window, fromBlock: null, toBlock: null, moves: [], notRecognised: { count: 0, reasons: [] }, scannedTransactions: 0, pages: 0, text: "PARTIAL: wallet history could not be read. This does not mean the wallet has no activity. Try again.", ditto: { version: "0.1.0", chain: args.chain, generatedAt: new Date(options.now ?? Date.now()).toISOString(), timingsMs: {}, labels: ["LIVE", "PARTIAL"], incomplete: true, reason: "RPC_UNAVAILABLE: history bounds or initial reads could not be resolved." } });
  }
}
