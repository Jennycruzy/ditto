import * as z from "zod/v4";
import { toHex, type Hex } from "viem";
import { hashSchema, addressSchema } from "../schemas.js";
import type { Rpc } from "../rpc.js";
import type { Chain } from "../chains.js";
import { quantity, walletMovesInputSchema, walletMovesSchema } from "./schemas.js";
import { explainTransaction } from "./service.js";
import type { DiscoveryOptions } from "./discover.js";

const blockSchema = z.object({ number: quantity, timestamp: quantity });
type Block = z.infer<typeof blockSchema>;
const pageSchema = z.object({ transfers: z.array(z.object({ hash: hashSchema, blockNum: quantity, from: addressSchema, to: addressSchema.nullable(), metadata: z.object({ blockTimestamp: z.iso.datetime() }).optional() })).max(100), pageKey: z.string().min(1).max(512).optional() });
// ASSUMED block times are only search seeds. Observed timestamps bound the scan;
// exact per-transaction timestamps enforce the requested window.
const estimatedBlockMs: Record<Chain, bigint> = { base: 2000n, optimism: 2000n, arbitrum: 250n, ethereum: 12000n };
export async function windowStart(rpc: Rpc, latest: Hex | Block, cutoff: bigint, chain: Chain = "base") {
  const head = typeof latest === "string" ? blockSchema.parse(await rpc.call("eth_getBlockByNumber", [latest, false])) : latest;
  let high = BigInt(head.number), highTime = BigInt(head.timestamp), low = 0n, lowTime: bigint | undefined;
  let next = high - (highTime - cutoff) * 1000n / estimatedBlockMs[chain];
  const seen = new Set<string>();
  for (let n = 0; n < 3; n++) {
    next = next < low ? low : next >= high ? high - 1n : next;
    if (next < 0n || seen.has(next.toString())) break;
    seen.add(next.toString());
    const b = blockSchema.parse(await rpc.call("eth_getBlockByNumber", [toHex(next), false]));
    if (BigInt(b.number) !== next) throw new Error("RPC_UNAVAILABLE: wrong block returned");
    const time = BigInt(b.timestamp);
    if (time === cutoff) return toHex(next);
    if (time < cutoff) { low = next; lowTime = time; }
    else { high = next; highTime = time; }
    if (high <= low + 1n) break;
    const span = lowTime === undefined ? BigInt(head.number) - high : high - low;
    const elapsed = lowTime === undefined ? BigInt(head.timestamp) - highTime : highTime - lowTime;
    if (elapsed > 0n && span > 0n) next = lowTime === undefined ? high - (highTime - cutoff) * span / elapsed - 1n : low + (cutoff - lowTime) * span / elapsed;
    else next = (low + high) / 2n;
  }
  // This observed lower bound may include a few older blocks. Filter rows by time.
  // If no lower bound was observed, block zero is conservative rather than guessing.
  return toHex(low);
}
async function readWalletMoves(input: unknown, rawRpc: Rpc, options: DiscoveryOptions & { now?: number; maxPages?: number } = {}) {
  const started = performance.now(), args = walletMovesInputSchema.parse(input);
  let requests = 0;
  const cache = new Map<string, Promise<unknown>>();
  const rpc: Rpc = {
    call: <T>(method: string, params: readonly unknown[]) => {
      const key = JSON.stringify([method, params]); let work = cache.get(key);
      if (!work) { requests++; work = rawRpc.call(method, params); cache.set(key, work); }
      return work as Promise<T>;
    },
    batch: async <T>(calls: readonly { method: string; params: readonly unknown[] }[]) => {
      const missing = calls.filter(c => !cache.has(JSON.stringify([c.method, c.params])));
      if (missing.length) {
        requests++; const result = rawRpc.batch<T>(missing);
        missing.forEach((c, n) => cache.set(JSON.stringify([c.method, c.params]), result.then(r => r[n])));
      }
      return Promise.all(calls.map(c => cache.get(JSON.stringify([c.method, c.params])) as Promise<T>));
    },
  };
  const latest = blockSchema.parse(await rpc.call("eth_getBlockByNumber", ["latest", false]));
  const seconds = BigInt(args.window === "24h" ? 86400 : args.window === "7d" ? 604800 : 2592000);
  const cutoff = BigInt(latest.timestamp) > seconds ? BigInt(latest.timestamp) - seconds : 0n;
  const fromBlock = await windowStart(rpc, latest, cutoff, args.chain);
  let incomplete = false, pages = 0;
  const failures: { txHash: string; reason: string }[] = [], hashes = new Map<string, string>(), times = new Map<string, string>();
  times.set(latest.number, new Date(Number(BigInt(latest.timestamp)) * 1000).toISOString());
  const maxPages = Math.min(12, options.maxPages ?? 4);
  const cursors: (string | undefined)[] = [undefined, undefined], done = [false, false], seen = [new Set<string>(), new Set<string>()];
  for (let n = 0; n < maxPages && !done.every(Boolean); n++) {
    await Promise.all([0, 1].filter(d => !done[d]).map(async direction => {
      try {
        const raw = await rpc.call("alchemy_getAssetTransfers", [{ fromBlock, toBlock: latest.number, [direction === 0 ? "fromAddress" : "toAddress"]: args.wallet, category: ["external", "erc20", "erc721", ...(args.chain === "ethereum" ? ["internal"] : [])], withMetadata: true, excludeZeroValue: false, maxCount: "0x64", order: "desc", ...(cursors[direction] ? { pageKey: cursors[direction] } : {}) }]);
        const page = pageSchema.parse(raw); pages++;
        for (const t of page.transfers) {
          if (t.from.toLowerCase() !== args.wallet.toLowerCase() && t.to?.toLowerCase() !== args.wallet.toLowerCase()) throw new Error("Invalid wallet transfer response");
          const time = t.metadata?.blockTimestamp;
          if (time) times.set(t.blockNum, time);
          if (BigInt(t.blockNum) >= BigInt(fromBlock) && BigInt(t.blockNum) <= BigInt(latest.number) && (!time || BigInt(Math.floor(Date.parse(time) / 1000)) >= cutoff)) hashes.set(t.hash.toLowerCase(), t.blockNum);
        }
        if (!page.pageKey) done[direction] = true;
        else if (seen[direction]!.has(page.pageKey)) { incomplete = true; done[direction] = true; }
        else { seen[direction]!.add(page.pageKey); cursors[direction] = page.pageKey; }
      } catch { incomplete = true; done[direction] = true; }
    }));
    if (hashes.size >= args.limit) { if (!done.every(Boolean)) incomplete = true; break; }
  }
  if (!done.every(Boolean)) incomplete = true;
  const candidates = [...hashes].sort((a, b) => BigInt(a[1]) === BigInt(b[1]) ? a[0].localeCompare(b[0]) : BigInt(a[1]) > BigInt(b[1]) ? -1 : 1);
  if (candidates.length > args.limit) incomplete = true;
  const selected = candidates.slice(0, args.limit);
  const resolved = await Promise.all(selected.map(async ([hash, block]) => {
    try {
      let time = times.get(block);
      if (!time) {
        const b = blockSchema.parse(await rpc.call("eth_getBlockByNumber", [block, false]));
        if (b.number !== block) throw new Error("RPC_UNAVAILABLE: wrong history block");
        time = new Date(Number(BigInt(b.timestamp)) * 1000).toISOString(); times.set(block, time);
      }
      if (BigInt(Math.floor(Date.parse(time) / 1000)) < cutoff) return [];
      const result = await explainTransaction({ chain: args.chain, tx: hash }, rpc, options);
      if (result.block !== BigInt(block).toString()) throw new Error("RPC_UNAVAILABLE: transfer and receipt blocks disagree");
      if (result.ditto.incomplete) incomplete = true;
      const actions = result.actions.filter(a => a.actor.toLowerCase() === args.wallet.toLowerCase() && a.kind !== "other");
      if (!actions.length) { failures.push({ txHash: hash, reason: result.reasons[0] ?? "UNRECOGNISED: no supported action credited to this wallet." }); return []; }
      return actions.map(a => ({ ...a, time: time! }));
    } catch { incomplete = true; failures.push({ txHash: hash, reason: "RPC_UNAVAILABLE: receipt or contract reads could not be completed." }); return []; }
  }));
  failures.sort((a, b) => a.txHash.localeCompare(b.txHash));
  return walletMovesSchema.parse({ wallet: args.wallet, window: args.window, fromBlock: BigInt(fromBlock).toString(), toBlock: BigInt(latest.number).toString(), moves: resolved.flat(), notRecognised: { count: failures.length, reasons: failures }, scannedTransactions: selected.length, pages, requests, text: `Found ${resolved.flat().length} recognised wallet actions in ${args.window} from ${selected.length} inspected transactions. ${failures.length} transactions had no resolved supported action.${incomplete ? " PARTIAL: the page, transaction, or RPC budget was reached; this is not the wallet's complete history." : ""}`, ditto: { version: "0.1.0", chain: args.chain, generatedAt: new Date(options.now ?? Date.now()).toISOString(), timingsMs: { total: performance.now() - started }, labels: incomplete ? ["LIVE", "PARTIAL"] : ["LIVE"], incomplete, ...(incomplete ? { reason: "History is bounded; more pages or unresolved reads remain." } : {}) } });
}
export async function walletMoves(input: unknown, rpc: Rpc, options: DiscoveryOptions & { now?: number; maxPages?: number } = {}) {
  const args = walletMovesInputSchema.parse(input);
  try { return await readWalletMoves(args, rpc, options); }
  catch {
    return walletMovesSchema.parse({ wallet: args.wallet, window: args.window, fromBlock: null, toBlock: null, moves: [], notRecognised: { count: 0, reasons: [] }, scannedTransactions: 0, pages: 0, requests: 0, text: "PARTIAL: wallet history could not be read. This does not mean the wallet has no activity. Try again.", ditto: { version: "0.1.0", chain: args.chain, generatedAt: new Date(options.now ?? Date.now()).toISOString(), timingsMs: {}, labels: ["LIVE", "PARTIAL"], incomplete: true, reason: "RPC_UNAVAILABLE: history bounds or initial reads could not be resolved." } });
  }
}
