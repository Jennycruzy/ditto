import { decodeFunctionData, decodeEventLog, parseAbi, type Hex } from "viem";
import provenance from "../provenance.json" with { type: "json" };
import { fragments, events } from "../abis.js";
import { recipes } from "../recipes/index.js";
import { assertVaultExecution } from "../recipes/erc4626.js";
import type { RecogniseContext, Receipt } from "../recipes/types.js";
import { parseTokenTransfers } from "../simulate.js";
import { chainConfig } from "../chains.js";
import type { Chain } from "../chains.js";
import { explanationSchema, receiptSchema, transactionSchema, type Explanation } from "./schemas.js";
import { quote } from "../text.js";

export function transactionHash(chain: Chain, input: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(input)) return input.toLowerCase() as Hex;
  let u: URL; try { u = new URL(input); } catch { throw new Error("Invalid transaction hash or explorer URL"); }
  const expected = new URL(chainConfig(chain).explorer);
  const match = /^\/tx\/(0x[0-9a-fA-F]{64})\/?$/.exec(u.pathname);
  if (u.origin !== expected.origin || u.username || u.password || u.search || u.hash || !match) throw new Error("Use this chain's explorer transaction URL");
  return match[1]!.toLowerCase() as Hex;
}
export function decodeReceipt(chain: Chain, rawTx: unknown, rawReceipt: unknown, context: RecogniseContext, options: { now?: number; incomplete?: boolean; reason?: string } = {}): Explanation {
  if (context.chain !== chain) throw new Error("CHAIN_UNSUPPORTED");
  const tx = transactionSchema.parse(rawTx), receipt = rawReceipt === null ? null : receiptSchema.parse(rawReceipt);
  if (receipt && (receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase() || receipt.blockHash.toLowerCase() !== tx.blockHash?.toLowerCase() || receipt.blockNumber !== tx.blockNumber || receipt.from !== tx.from || receipt.to !== tx.to)) throw new Error("RPC_UNAVAILABLE: transaction and receipt disagree");
  const status = !receipt ? "pending" : receipt.status === "0x1" ? "success" : "reverted";
  const selector = tx.input.length >= 10 ? tx.input.slice(0, 10) : null;
  let fn = "unknown function";
  for (const fragment of Object.values(fragments)) {
    try { fn = decodeFunctionData({ abi: parseAbi([fragment]), data: tx.input as Hex }).functionName; break; } catch { /* Unknown selectors are data. */ }
  }
  let route: Explanation["route"] = "unknown";
  if (["0x1fad948c", "0x765e827f"].includes(selector ?? "")) { route = "erc4337"; fn = "handleOps"; }
  else if (selector === "0x6a761202") { route = "safe"; fn = "execTransaction"; }
  else if (chain === "base" && tx.to?.toLowerCase() === provenance.routes.morphoBase.toLowerCase()) { route = "morpho-bundler"; fn = selector === "0x6bbba4e0" ? "vaultBundlesV1Deposit" : "unknown function"; }
  else if (selector === "0xac9650d8" || selector === "0x5ae401dc") { route = "multicall"; fn = "multicall"; }
  else if (context.identities.some(i => i.chain === chain && tx.to === (i.family === "lp-v3" ? i.receiptToken : i.contract))) route = "direct";
  else if (receipt) route = "router";
  const movements = receipt?.status === "0x1" ? parseTokenTransfers(receipt.logs) : [];
  const recognised = receipt?.status === "0x1" ? Object.values(recipes).filter(r => r.chains.includes(chain)).flatMap(r => r.recognise(receipt as Receipt, context)) : [];
  const actions = recognised.map(a => {
    const i = context.identities.find(i => i.chain === chain && i.family === a.family && i.contract === a.contract && i.asset === a.asset)!;
    const reasons: string[] = [];
    if (a.kind !== "enter") reasons.push(a.kind === "other" ? "Borrowing and repayment are outside Ditto's copy scope." : "This is an exit; use a fresh exit plan for your own position.");
    if (!i.provenance.verified) reasons.push("UNKNOWN_PROVENANCE: this contract is explain-only.");
    if (i.family === "erc4626") { try { assertVaultExecution(i); } catch (e) { reasons.push(`${(e as Error).message}: execution checks must pass before this vault can be copied.`); } }
    const position = a.tokenId ? context.lpPositions?.[`${i.receiptToken.toLowerCase()}:${a.tokenId}`] : undefined;
    let lpPosition;
    if (position && a.tokenId) {
      for (const log of receipt!.logs.filter(l => l.address === i.receiptToken)) {
        try {
          const decoded = decodeEventLog({ abi: parseAbi([a.kind === "enter" ? events.increase : events.collect]), data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
          if (String(decoded.args.tokenId) === a.tokenId) { lpPosition = { token0: position.token0, token1: position.token1, amount0: String(decoded.args.amount0), amount1: String(decoded.args.amount1), tickLower: position.tickLower, tickUpper: position.tickUpper }; break; }
        } catch { /* Only the position's own matching event supplies its amounts. */ }
      }
    }
    const halfWidthTicks = position ? Math.ceil((position.tickUpper - position.tickLower) / 2) : undefined;
    if (a.family === "lp-v3" && (!halfWidthTicks || halfWidthTicks <= 0)) reasons.push("UNRECOGNISED: no observed range width for this position.");
    if (i.paused) reasons.push("PAUSED: this market cannot accept a copy now.");
    const warnings = Array.isArray(i.details.warnings) ? i.details.warnings.filter((w): w is string => typeof w === "string").map(quote) : [];
    if (i.family === "erc4626") { warnings.push(quote("Pause status needs a fresh simulation.")); if (i.details.warningStatus === "unavailable") warnings.push(quote("Morpho warnings unavailable.")); }
    return { ...a, candidateId: `${chain}:${a.family}:${a.contract}`, copyable: reasons.length ? "no" as const : "yes" as const, reasons, ...(halfWidthTicks ? { halfWidthTicks } : {}), ...(lpPosition ? { lpPosition } : {}), warnings };
  });
  const incomplete = options.incomplete ?? false;
  const reasons = status !== "success" ? [status === "pending" ? "WAIT_PENDING: this transaction has no mined receipt yet." : "This transaction reverted; no action completed."] : !actions.length ? ["UNRECOGNISED: Ditto can't rebuild this yet."] : [];
  if (incomplete) reasons.push(options.reason ?? "PARTIAL: some contracts could not be checked.");
  const copyable = !incomplete && actions.some(a => a.copyable === "yes") ? "yes" : "no";
  const text = [status === "success" ? `Transaction ${tx.hash} called ${fn} via ${route}.` : `Transaction ${tx.hash} is ${status}.`, ...actions.map(a => `${a.actor}: ${a.lpPosition ? `${a.kind} position NFT ${a.tokenId}: ${a.lpPosition.amount0} atomic units of ${a.lpPosition.token0} and ${a.lpPosition.amount1} of ${a.lpPosition.token1}` : `${a.kind} ${a.amount} atomic units of ${a.asset}`} at ${a.contract} (${a.family}). ${a.copyable === "yes" ? "Ditto can rebuild this action with a fresh plan; current checks will run again." : a.reasons.join(" ")}${a.halfWidthTicks ? ` Observed half-width: ${a.halfWidthTicks} ticks; recenter on the current price.` : ""}${a.warnings.length ? ` Untrusted vault warnings: ${a.warnings.map(w => w.text).join(", ")}.` : ""}`), ...reasons, "Token movements come from receipt Transfer logs; internal native ETH movements are not available from a receipt alone."].join("\n");
  return explanationSchema.parse({ hash: tx.hash, block: receipt ? BigInt(receipt.blockNumber).toString() : null, who: tx.from, contract: tx.to, selector, function: fn, route, status, movements, actions, copyable, reasons, text, ditto: { version: "0.1.0", chain, generatedAt: new Date(options.now ?? Date.now()).toISOString(), timingsMs: {}, labels: incomplete ? ["LIVE", "PARTIAL"] : ["LIVE"], incomplete, ...(options.reason ? { reason: options.reason } : {}) } });
}
