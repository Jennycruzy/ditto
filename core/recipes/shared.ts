import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import type { Rpc, RpcCall } from "../rpc.js";
import { fragments } from "../abis.js";
import { makeStep } from "../encoding.js";
import { displayAmount } from "../text.js";
import { simulate, walletDeltas, type Simulation } from "../simulate.js";
import { encodeStep } from "../encoding.js";
import type { Position, Step } from "../schemas.js";
import type { BuildOptions, Identity, Receipt, RecogniseContext, Recognised } from "./types.js";

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const MAX = (2n ** 256n - 1n).toString();
export const addr = (s: string) => getAddress(s.toLowerCase());
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const value = (atomic: string | bigint, decimals: number) => ({ atomic: atomic.toString(), display: displayAmount(atomic.toString(), decimals) });
export function call(to: Address, fragment: string, args: readonly unknown[] = [], block: Hex | "latest" = "latest"): RpcCall {
  const abi: Abi = parseAbi([fragment] as readonly string[]); const fn = abi[0];
  if (!fn || fn.type !== "function") throw new Error("Invalid read interface");
  return { method: "eth_call", params: [{ to, data: encodeFunctionData({ abi, functionName: fn.name, args: args as never }) }, block] };
}
export function decode(fragment: string, data: unknown): unknown {
  const abi: Abi = parseAbi([fragment] as readonly string[]); const fn = abi[0];
  if (!fn || fn.type !== "function" || typeof data !== "string") throw new Error("RPC_UNAVAILABLE");
  return decodeFunctionResult({ abi, functionName: fn.name, data: data as Hex });
}
export async function read(rpc: Rpc, to: Address, fragment: string, args: readonly unknown[] = [], block: Hex | "latest" = "latest") {
  const c = call(to, fragment, args, block); return decode(fragment, await rpc.call(c.method, c.params));
}
export async function reads(rpc: Rpc, entries: { to: Address; fragment: string; args?: readonly unknown[] }[], block: Hex | "latest" = "latest"): Promise<unknown[]> {
  const raw = await rpc.batch(entries.map(e => call(e.to, e.fragment, e.args, block)));
  return raw.map((v, i) => decode(entries[i]!.fragment, v));
}
export const f = {
  balance: "function balanceOf(address) view returns (uint256)", allowance: "function allowance(address,address) view returns (uint256)", decimals: "function decimals() view returns (uint8)",
  asset: "function asset() view returns (address)", totalAssets: "function totalAssets() view returns (uint256)",
  previewDeposit: "function previewDeposit(uint256) view returns (uint256)", previewRedeem: "function previewRedeem(uint256) view returns (uint256)", maxDeposit: "function maxDeposit(address) view returns (uint256)",
  convert: "function convertToAssets(uint256) view returns (uint256)", symbol: "function symbol() view returns (string)",
};
export function requireIdentity(i: Identity, family: Identity["family"]) {
  if (i.family !== family || !i.provenance.verified) throw new Error("UNKNOWN_PROVENANCE");
  if (i.paused) throw new Error("PAUSED");
}
export function positive(amount: string) { if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) >= 2n ** 256n) throw new Error("AMOUNT_OVER_LIMIT"); return BigInt(amount); }
export function approvals(token: Address, spender: Address, amount: string, options: BuildOptions = {}): Step[] {
  if (options.allowance === amount) return [];
  return [ ...(options.zeroFirst && options.allowance !== "0" ? [makeStep("approve-zero", token, fragments.approve, [spender, "0"])] : []), makeStep("approve", token, fragments.approve, [spender, amount]) ];
}
export function expectations(i: Identity, wallet: Address, amount: string, minimum: string): Step["expect"] {
  return [
    { kind: "token-out", token: i.asset, account: wallet, amount: value(amount, i.assetDecimals) },
    { kind: "token-in", token: i.receiptToken, account: wallet, minimum: value(minimum, i.receiptDecimals) },
    ...(i.asset !== "native" ? [{ kind: "allowance" as const, token: i.asset, account: wallet, spender: i.contract, amount: value("0", i.assetDecimals) }] : []),
  ];
}
export function minAfterSlip(amount: bigint, bps = 50): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 100) throw new Error("Invalid slippage");
  return amount * BigInt(10_000 - bps) / 10_000n;
}
export function parseEvents(receipt: Receipt, ctx: RecogniseContext, family: Identity["family"], rules: { event: string; kind: Recognised["kind"]; actor: string; amount: string; shares?: string; asset?: string }[]): Recognised[] {
  if (receipt.status !== "0x1") return [];
  const out: Recognised[] = [];
  for (const log of receipt.logs) {
    if (log.removed) continue;
    const identities = ctx.identities.filter(i => i.family === family && i.chain === ctx.chain && same(i.contract, log.address));
    if (!identities.length) continue;
    for (const rule of rules) {
      try {
        const decoded = decodeEventLog({ abi: parseAbi([rule.event] as readonly string[]), data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
        const args = decoded.args as unknown as Record<string, unknown>;
        const identity = rule.asset ? identities.find(i => same(i.asset, args[rule.asset!] as string)) : identities[0];
        if (!identity) continue;
        const asset = rule.asset ? addr(args[rule.asset] as string) : identity.asset;
        const amount = args[rule.amount] as bigint;
        out.push({ kind: rule.kind, family, contract: identity.contract, asset, actor: addr(args[rule.actor] as string), amount: amount.toString(), txHash: receipt.transactionHash, ...(rule.shares ? { receiptAmount: String(args[rule.shares]) } : {}) });
      } catch { /* Unrelated events stay data. */ }
    }
  }
  return out;
}
export async function basicPosition(i: Identity, wallet: Address, rpc: Rpc, toAssets: (balance: bigint) => Promise<bigint>, exits: (balance: string) => Step[]): Promise<Position> {
  const balance = await read(rpc, i.receiptToken, f.balance, [wallet]) as bigint;
  const assets = await toAssets(balance);
  let returns: Position["exitPreview"]["returns"] = [], pass = false, block = "0";
  if (balance > 0n) {
    const sim = await simulate(rpc, exits(balance.toString()).map(s => ({ ...encodeStep(s), from: wallet, value: `0x${BigInt(s.value).toString(16)}` as Hex })));
    block = sim.block;
    returns = walletDeltas(sim.calls.flatMap(c => c.transfers), wallet).filter(d => same(d.token, i.asset) && BigInt(d.delta) > 0n).map(d => ({ token: d.token, amount: value(d.delta, i.assetDecimals) }));
    pass = returns.reduce((sum, r) => sum + BigInt(r.amount.atomic), 0n) >= exitMinimum(i.family, assets) && (i.family !== "moonwell" || sim.calls.every(c => c.returnData.length === 66 && BigInt(c.returnData) === 0n));
  }
  return { family: i.family, chain: i.chain, contract: i.contract, wallet, receiptToken: i.receiptToken, amountIn: null, balance: value(balance, i.receiptDecimals), valueNow: value(assets, i.assetDecimals), change: null, exitCandidateId: `${i.chain}:${i.family}:${i.contract}`, exitPreview: { simulated: true, block, exitClass: "instant", returns, pass, detail: balance > 0n ? (pass ? "Exit simulated now; future liquidity can change." : "Exit simulation failed; do not propose this exit.") : "No position to exit." } };
}
export function received(sim: Simulation, wallet: Address, token: Address): bigint {
  return sim.calls.flatMap(c => c.transfers).filter(t => t.kind === "erc20" && same(t.token, token) && same(t.to, wallet)).reduce((sum, t) => sum + BigInt(t.amount), 0n);
}
export function exitMinimum(family: Identity["family"], amount: bigint): bigint {
  const minimum = family === "aave-v3" || family === "compound-v3" ? amount - 2n : family === "moonwell" ? amount * 9995n / 10000n : amount * 999n / 1000n - 2n;
  return minimum > 0n ? minimum : 0n;
}
