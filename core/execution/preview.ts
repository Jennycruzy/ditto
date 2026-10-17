import { decodeAbiParameters, toHex, type Address, type Hex } from "viem";
import { encodeStep } from "../encoding.js";
import { simulate, walletDeltas, type StateOverrides, type Simulation } from "../simulate.js";
import { recipes, entryAssertions, exitMinimum, normalizedIncomeFragment } from "../recipes/index.js";
import { call, decode, f, same, value } from "../recipes/shared.js";
import type { Identity } from "../recipes/types.js";
import type { Rpc } from "../rpc.js";
import type { Step, Preview } from "../schemas.js";
export const asCall = (step: Step, wallet: Address) => ({ ...encodeStep(step), from: wallet, value: toHex(BigInt(step.value)) });
export function permissions(steps: readonly Step[]) {
  const out: { token: Address; spender: Address }[] = [];
  for (const s of steps) if (["approve", "approve-zero", "revoke"].includes(s.kind)) {
    const spender = s.args[0] as Address;
    if (!out.some(p => same(p.token, s.to) && same(p.spender, spender))) out.push({ token: s.to, spender });
  }
  return out;
}
// Permissions come from the whole plan, not only the steps left to simulate: after a
// confirmed approve (or an exact pre-existing allowance) the enter still needs its
// spender's post-entry allowance read, or the zero-allowance check has nothing to prove.
export async function entryPreview(i: Identity, wallet: Address, amount: string, steps: Step[], rpc: Rpc, block: Hex, overrides?: StateOverrides, planPermissions: readonly { token: Address; spender: Address }[] = []) {
  const perms = [...permissions(steps)];
  for (const p of planPermissions) if (!perms.some(q => same(q.token, p.token) && same(q.spender, p.spender))) perms.push({ token: p.token, spender: p.spender });
  const probes = perms.map(p => call(p.token, f.allowance, [wallet, p.spender], block));
  const extra = i.family === "aave-v3" ? normalizedIncomeFragment : i.family === "erc4626" ? f.previewDeposit : null;
  const extraArgs = i.family === "aave-v3" ? [i.asset] : [amount];
  const calls = [...steps.map(s => asCall(s, wallet)), ...probes.map(p => ({ ...(p.params[0] as { to: Address; data: Hex }), from: wallet }))];
  if (extra) calls.push({ ...(call(i.contract, extra, extraArgs).params[0] as { to: Address; data: Hex }), from: wallet });
  const sim = await simulate(rpc, calls, { block, ...(overrides ? { stateOverrides: overrides } : {}) });
  const allowanceReads = perms.map((p, n) => ({ ...p, amount: BigInt(sim.calls[steps.length + n]!.returnData).toString() }));
  const checked = structuredClone(i);
  if (extra && i.family === "aave-v3") Object.assign(checked.details, { normalizedIncome: BigInt(sim.calls.at(-1)!.returnData).toString(), normalizedIncomeBlock: sim.block });
  if (extra && i.family === "erc4626") Object.assign(checked.details, { previewFor: amount, previewBlock: sim.block, previewShares: BigInt(sim.calls.at(-1)!.returnData).toString() });
  const assertions = entryAssertions(recipes[i.family]!, checked, wallet, amount, sim, steps.length, allowanceReads);
  const receiptDelta = walletDeltas(sim.calls.slice(0, steps.length).flatMap(c => c.transfers), wallet).find(d => same(d.token, i.receiptToken));
  const shares = receiptDelta && BigInt(receiptDelta.delta) > 0n ? receiptDelta.delta : "0";
  const minimum = recipes[i.family]!.expect(checked, wallet, amount, sim).find(e => e.kind === "token-in")?.minimum?.atomic ?? "1";
  let exitOptions: import("../recipes/types.js").BuildOptions = { shares: true, positionBalance: shares, acceptExit: i.family === "lp-v3" ? "market" : "queued", allowance: "0" };
  if (i.family === "lp-v3") {
    const mint = sim.calls[steps.findIndex(s => s.kind === "enter")]!;
    const [id, liquidity, amount0, amount1] = decodeAbiParameters([{ type: "uint256" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }], mint.returnData);
    exitOptions = { ...exitOptions, tokenId: id.toString(), liquidity: liquidity.toString(), min0: (amount0 * 9950n / 10000n).toString(), min1: (amount1 * 9950n / 10000n).toString() };
  }
  const exit = recipes[i.family]!.buildExit(i, wallet, i.family === "lp-v3" ? "all" : shares, exitOptions);
  let full: Simulation;
  try { full = await simulate(rpc, [...steps.map(s => asCall(s, wallet)), ...exit.map(s => asCall(s, wallet))], { block, ...(overrides ? { stateOverrides: overrides } : {}) }); }
  catch (error) { if (((error as { callIndex?: number }).callIndex ?? -1) >= steps.length) throw new Error("EXIT_FAILS: the exit reverted in the simulated round trip"); throw error; }
  const returned = walletDeltas(full.calls.slice(steps.length).flatMap(c => c.transfers), wallet).filter(d => BigInt(d.delta) > 0n);
  const returnedAsset = returned.find(d => same(d.token, i.asset));
  let exitPass = BigInt(returnedAsset?.delta ?? "0") >= exitMinimum(i.family, BigInt(amount));
  if (i.family === "lst") exitPass = full.calls.slice(steps.length).some(c => c.transfers.some(t => t.kind === "erc721" && same(t.to, wallet)));
  if (i.family === "moonwell") exitPass &&= full.calls.slice(steps.length).every(c => BigInt(c.returnData) === 0n);
  if (i.family === "lp-v3") {
    const delta = walletDeltas(full.calls.flatMap(c => c.transfers), wallet), price = BigInt(String(i.details.sqrtPriceX96));
    const d0 = BigInt(delta.find(d => same(d.token, String(i.details.token0)))?.delta ?? "0"), d1 = BigInt(delta.find(d => same(d.token, String(i.details.token1)))?.delta ?? "0");
    const net = same(String(i.details.token0), i.asset) ? d0 + d1 * (1n << 192n) / (price * price) : d1 + d0 * price * price / (1n << 192n);
    exitPass = BigInt(amount) + net >= BigInt(amount) * 9900n / 10000n;
  }
  const tokens = (sim: Simulation, start: number, end: number) => {
    const ds = walletDeltas(sim.calls.slice(start, end).flatMap(c => c.transfers), wallet);
    const output = (positive: boolean) => ds.filter(d => positive ? BigInt(d.delta) > 0n : BigInt(d.delta) < 0n).map(d => ({ token: d.token, amount: value((BigInt(d.delta) < 0n ? -BigInt(d.delta) : BigInt(d.delta)), same(d.token, i.receiptToken) ? i.receiptDecimals : same(d.token, i.asset) ? i.assetDecimals : 18) }));
    return { out: output(false), in: output(true) };
  };
  const preview: Preview = { simulated: true, balancesOverridden: !!overrides, block: sim.block, perStep: steps.map((_, n) => ({ ...tokens(sim, n, n + 1), gasUsed: value(sim.calls[n]!.gasUsed, 0) })), net: tokens(sim, 0, steps.length), allowanceAfter: value(allowanceReads.reduce((s, p) => s + BigInt(p.amount), 0n), i.assetDecimals), exitPreview: { simulated: true, block: full.block, exitClass: i.family === "lp-v3" ? "market" : i.family === "lst" ? "queued" : "instant", returns: returned.map(d => ({ token: d.token, amount: value(d.delta, same(d.token, i.asset) ? i.assetDecimals : same(d.token, i.receiptToken) ? i.receiptDecimals : 18) })), pass: exitPass, detail: i.family === "lst" ? "The queue request returns a future-claim NFT, not instant ETH." : i.family === "lp-v3" ? "The exit returns a mix of both tokens. Price and that mix can change." : "The exit works in this simulated block; future liquidity can change." } };
  return { preview, assertions, shares, minimum, exit, sim, full, exitOptions };
}
