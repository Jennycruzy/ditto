import { decodeFunctionData, decodeEventLog, parseAbi, type Hex } from "viem";
import provenance from "../provenance.json" with { type: "json" };
import { fragments, events } from "../abis.js";
import { recipes } from "../recipes/index.js";
import { assertVaultExecution } from "../recipes/erc4626.js";
import type { RecogniseContext, Receipt } from "../recipes/types.js";
import { parseTokenTransfers } from "../simulate.js";
import { chainConfig, usdcAddress } from "../chains.js";
import type { Chain } from "../chains.js";
import { explanationSchema, receiptSchema, transactionSchema, type Explanation } from "./schemas.js";
import { quote, displayAmount } from "../text.js";

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
          if (String(decoded.args.tokenId) === a.tokenId && String(position.token0 === i.asset ? decoded.args.amount0 : decoded.args.amount1) === a.amount) { lpPosition = { token0: position.token0, token1: position.token1, amount0: String(decoded.args.amount0), amount1: String(decoded.args.amount1), tickLower: position.tickLower, tickUpper: position.tickUpper }; break; }
        } catch { /* Only the position's own matching event supplies its amounts. */ }
      }
    }
    if (!lpPosition && position && a.kind === "exit" && a.amount0 !== undefined && a.amount1 !== undefined) lpPosition = { token0: position.token0, token1: position.token1, amount0: a.amount0, amount1: a.amount1, tickLower: position.tickLower, tickUpper: position.tickUpper };
    if (lpPosition && a.kind === "exit" && a.amount0 !== undefined && a.amount1 !== undefined) { lpPosition.amount0 = a.amount0; lpPosition.amount1 = a.amount1; }
    if (lpPosition && a.kind === "enter" && (lpPosition.amount0 === "0" || lpPosition.amount1 === "0")) reasons.push("This one-token range order sits outside the current price. Ditto cannot copy it as a centred liquidity position.");
    const halfWidthTicks = position ? Math.ceil((position.tickUpper - position.tickLower) / 2) : undefined;
    if (a.family === "lp-v3" && (!halfWidthTicks || halfWidthTicks <= 0)) reasons.push("UNRECOGNISED: no observed range width for this position.");
    if (i.paused) reasons.push("PAUSED: this market cannot accept a copy now.");
    const warnings = Array.isArray(i.details.warnings) ? i.details.warnings.filter((w): w is string => typeof w === "string").map(quote) : [];
    const notes: string[] = [];
    if (i.family === "erc4626") {
      notes.push("Ditto: ERC-4626 has no standard pause getter; deposit and exit need a fresh simulation.");
      notes.push(i.details.warningStatus === "not-morpho" || i.provenance.named ? "Not a Morpho vault, so no Morpho warnings." : i.details.warningStatus === "unavailable" ? "Morpho warnings unavailable." : "Morpho warnings were read as third-party data.");
    }
    const d = (i.details.display ?? {}) as Record<string, { symbol?: string; name?: string }>;
    const amount = (atomic: string, decimals: number, symbol: string | undefined, fallback: string, shares = false) => `${shares && decimals > 6 ? (BigInt(atomic) > 0n && BigInt(atomic) < 10n ** BigInt(decimals - 6) ? "<0.000001" : displayAmount(((BigInt(atomic) + 5n * 10n ** BigInt(decimals - 7)) / 10n ** BigInt(decimals - 6)).toString(), 6)) : displayAmount(atomic, decimals).replace(/(\.[0-9]*?)0+$/, "$1").replace(/\.$/, "")} ${chain !== "ethereum" && fallback.toLowerCase() === usdcAddress(chain).toLowerCase() ? "USDC" : symbol ? quote(symbol).text : fallback}`;
    const assetAmount = amount(a.amount, i.assetDecimals, d.asset?.symbol, i.asset === "native" ? "ETH" : i.asset);
    const label = d.contract?.name ? quote(d.contract.name).text : i.family === "lp-v3" ? `${i.details.protocol === "uniswap" ? "Uniswap v3" : "Aerodrome Slipstream"} ${d.token0?.symbol ? quote(d.token0.symbol).text : String(i.details.token0)}/${d.token1?.symbol ? quote(d.token1.symbol).text : String(i.details.token1)} pool` : i.family === "aave-v3" ? `Aave v3 ${d.asset?.symbol ? quote(d.asset.symbol).text : i.asset} pool` : i.family === "compound-v3" ? "Compound v3 market" : i.family === "moonwell" ? "Moonwell market" : i.family === "lst" ? "Lido" : `vault ${i.contract}`;
    const movementsForActor = movements.filter(t => t.kind === "erc20" && t.token === i.receiptToken && t.to === a.actor && /^0x0{40}$/i.test(t.from));
    const received = a.receiptAmount ?? (movementsForActor.length ? movementsForActor.reduce((sum, t) => sum + BigInt(t.amount), 0n).toString() : undefined);
    const sharesText = received ? ` and ${a.kind === "enter" ? "received" : "burned"} ${amount(received, i.receiptDecimals, d.receipt?.symbol, "receipt shares", true)}` : a.kind === "enter" && i.family === "compound-v3" ? "; no new receipt tokens were minted in this transaction" : "";
    const description = lpPosition ? `${a.actor} ${a.kind === "enter" ? "opened" : "exited"} position NFT ${a.tokenId} in ${label}, with ${amount(lpPosition.amount0, Number(i.details.decimals0), d.token0?.symbol, lpPosition.token0)} and ${amount(lpPosition.amount1, Number(i.details.decimals1), d.token1?.symbol, lpPosition.token1)}${a.kind === "enter" ? ", and received the position NFT" : ""}.` : `${a.actor} ${a.kind === "enter" ? "deposited" : a.kind === "exit" ? "withdrew" : "moved"} ${assetAmount} ${a.kind === "exit" ? "from" : "into"} ${label}${sharesText}.`;
    return { ...a, candidateId: `${chain}:${a.family}:${a.contract}`, copyable: reasons.length ? "no" as const : "yes" as const, reasons, ...(halfWidthTicks ? { halfWidthTicks } : {}), ...(lpPosition ? { lpPosition } : {}), warnings, notes, description };
  });
  const incomplete = options.incomplete ?? false;
  const reasons = status !== "success" ? [status === "pending" ? "WAIT_PENDING: this transaction has no mined receipt yet." : "This transaction reverted; no action completed."] : !actions.length ? ["UNRECOGNISED: Ditto can't rebuild this yet."] : [];
  if (incomplete) reasons.push(options.reason ?? "PARTIAL: some contracts could not be checked.");
  const copyable = !incomplete && actions.some(a => a.copyable === "yes") ? "yes" : "no";
  const routeWords = { direct: "directly", router: "through a router", multicall: "through a batch of calls", erc4337: "from a smart wallet via a bundler", safe: "from a Safe smart wallet", "morpho-bundler": "through a Morpho bundler", unknown: "through an unknown route" };
  const text = [status === "success" ? `This transaction called ${fn === "unknown function" ? "an unknown function" : fn} ${routeWords[route]}.` : `Transaction ${tx.hash} is ${status}.`, ...actions.map(a => `${a.description} ${a.copyable === "yes" ? "Ditto can rebuild this action with a fresh plan; current checks will run again." : a.reasons.join(" ")}${a.halfWidthTicks && a.kind === "enter" ? ` Observed half-width: ${a.halfWidthTicks} ticks; recenter on the current price.` : ""}${a.notes.length ? ` ${a.notes.join(" ")}` : ""}${a.warnings.length ? ` Third-party vault warnings (untrusted): ${a.warnings.map(w => w.text).join(", ")}.` : ""}`), ...reasons, ...(copyable === "yes" ? [actions.some(a => a.copyable === "yes" && chain !== "ethereum" && a.asset.toLowerCase() === usdcAddress(chain).toLowerCase()) ? 'Say "copy it with 1 USDC" to build your own plan.' : 'Say "copy it" with your chosen amount to build your own plan.'] : []), "Token movements come from receipt Transfer logs; internal native ETH movements are not available from a receipt alone."].join("\n");
  return explanationSchema.parse({ hash: tx.hash, block: receipt ? BigInt(receipt.blockNumber).toString() : null, who: tx.from, contract: tx.to, selector, function: fn, route, status, movements, actions, copyable, reasons, text, ditto: { version: "0.1.0", chain, generatedAt: new Date(options.now ?? Date.now()).toISOString(), timingsMs: {}, labels: incomplete ? ["LIVE", "PARTIAL"] : ["LIVE"], incomplete, ...(options.reason ? { reason: options.reason } : {}) } });
}
