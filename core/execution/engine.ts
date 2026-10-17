import * as z from "zod/v4";
import { randomBytes } from "node:crypto";
import { toHex, type Address, type Hex } from "viem";
import { assertAmountLimit, assertWallet, planHash, signPlan, verifyPlan } from "../plan.js";
import { addressSchema, amountSchema, chainSchema, familySchema, hashSchema, stepSchema, refusalCodes, type Plan, type Step, type Refusal } from "../schemas.js";
import { recipes, prepareLpEntry, prepareLpSwap, positionFragment } from "../recipes/index.js";
import { atomicAmount } from "../text.js";
import { makeStep, encodeStep } from "../encoding.js";
import { addr, call, f, read, reads, same, value, ZERO, exitMinimum } from "../recipes/shared.js";
import { morphoListing } from "../morpho.js";
import { medianPositionWidth } from "../recognise/width.js";
import { simulate, dryRunOverrides, walletDeltas, type StateOverrides } from "../simulate.js";
import { ethUsdPrice } from "./prices.js";
import { runChecks } from "./checks.js";
import { entryPreview, asCall, permissions } from "./preview.js";
import { reconcile } from "./progress.js";
import { describeStep, planSummary, symbolOf } from "./words.js";
import { planInstructions, refusal, refusalFrom, type Config, type Target, type Progress } from "./types.js";
import type { Identity, BuildOptions } from "../recipes/types.js";
import type { Rpc } from "../rpc.js";
const targetSchema = z.object({ chain: chainSchema, family: familySchema, contract: addressSchema }).strict();
export const planInputSchema = targetSchema.extend({ wallet: addressSchema, amount: z.string().min(1).max(128), slippageBps: z.number().int().min(0).max(100).default(50), acceptExit: z.enum(["queued", "market"]).optional() }).strict();
export const stepInputSchema = z.object({ plan: z.unknown(), wallet: addressSchema, txHashes: z.array(hashSchema).max(100).default([]) }).strict();
export const codeOf = (error: unknown): Refusal["code"] => { if (Array.isArray((error as { issues?: unknown })?.issues)) return "UNRECOGNISED"; const text = (error as Error)?.message ?? ""; return refusalCodes.find(c => text.includes(c)) ?? (text.includes("RPC_UNAVAILABLE") ? "RPC_UNAVAILABLE" : "SIM_FAILED"); };
export class ExecutionEngine {
  constructor(readonly rpc: Rpc, readonly config: Config) {}
  now() { return this.config.now?.() ?? Date.now(); }
  async identity(t: Target, wallet: Address, block: Hex) {
    let listing;
    if (t.family === "erc4626") { try { listing = await (this.config.listing ?? morphoListing)(t.contract, t.chain); } catch {} }
    const i = await recipes[t.family]!.identify(t.contract, t.chain, this.rpc, { wallet, block, ...(listing ? { listing } : {}) });
    if (!i) throw new Error("UNKNOWN_PROVENANCE");
    if (listing?.warnings) i.details.warnings = listing.warnings;
    return i;
  }
  async baseline(i: Identity, wallet: Address, block: Hex) {
    const [eth, position, asset, gasPrice] = await this.rpc.batch<Hex>([{ method: "eth_getBalance", params: [wallet, block] }, call(i.receiptToken, f.balance, [wallet], block), ...(i.asset === "native" ? [{ method: "eth_getBalance", params: [wallet, block] }] : [call(i.asset, f.balance, [wallet], block)]), { method: "eth_gasPrice", params: [] }]);
    return { eth: BigInt(eth!), position: BigInt(position!), asset: BigInt(asset!), gasPrice: BigInt(gasPrice!) };
  }
  bind(id: string, wallet: Address): Step { return stepSchema.parse({ kind: "bind", to: wallet, value: "0", selector: "0xd1770000", abiFragment: "bind", args: [id], expect: [] }); }
  async enter(input: unknown, dryRun = false) {
    try {
      const a = planInputSchema.parse(input), now = this.now(), block = await this.rpc.call<Hex>("eth_blockNumber", []);
      const i = await this.identity(a, a.wallet, block), amount = atomicAmount(a.amount, i.assetDecimals);
      assertAmountLimit(amount, i.assetDecimals, this.config.maxAmount);
      const exitClass = i.family === "lst" ? "queued" : i.family === "lp-v3" ? "market" : "instant";
      if (exitClass !== "instant" && a.acceptExit !== exitClass) throw new Error("EXIT_NOT_ACCEPTED");
      const base = await this.baseline(i, a.wallet, block), evidence = await this.config.evidence(i, this.rpc, block, now);
      const id = planHash({ ...a, block, now, nonce: randomBytes(16).toString("hex") });
      const originalAllowance = i.asset === "native" ? 0n : await read(this.rpc, i.asset, f.allowance, [a.wallet, i.contract], block) as bigint;
      const opts: BuildOptions & { block: Hex } = { allowance: originalAllowance.toString(), slippageBps: a.slippageBps, now, block, ...(a.acceptExit ? { acceptExit: a.acceptExit } : {}) };
      let steps: Step[];
      if (i.family === "lp-v3") {
        const observed = medianPositionWidth(evidence.lpRanges, a.chain, i.contract, now);
        if (!observed) throw new Error("NOT_ENOUGH_USE: no recent centred LP positions provide a range width");
        opts.halfWidthTicks = observed.halfWidthTicks;
        steps = (await prepareLpEntry(i, a.wallet, amount, this.rpc, opts)).steps;
      } else steps = recipes[i.family]!.buildEnter(i, a.wallet, amount, opts);
      // The recipe omits its approve when the allowance already equals the amount; its
      // spender still belongs to the plan so the post-entry allowance is checked and proven.
      const planned = permissions(steps);
      if (i.family !== "lp-v3" && i.asset !== "native" && !planned.some(p => same(p.token, i.asset) && same(p.spender, i.contract))) planned.push({ token: i.asset, spender: i.contract });
      const permissionReads = await reads(this.rpc, planned.map(p => ({ to: p.token, fragment: f.allowance, args: [a.wallet, p.spender] })), block);
      const permissionBaseline = planned.map((p, n) => ({ ...p, baseline: String(permissionReads[n]) }));
      steps = steps.filter(s => !(s.kind === "approve" && permissionBaseline.find(p => same(p.token, s.to) && same(p.spender, String(s.args[0])))?.baseline === s.args[1]));
      if (!steps[0] || !["approve", "approve-zero"].includes(steps[0].kind)) steps.unshift(this.bind(id, a.wallet));
      let overrides: StateOverrides | undefined;
      if (dryRun) overrides = i.asset === "native" ? { [a.wallet]: { balance: toHex(BigInt(amount) + 10n ** 16n) } } : dryRunOverrides(a.wallet, i.asset, BigInt(amount), 9n);
      let checked;
      try { checked = await entryPreview(i, a.wallet, amount, steps, this.rpc, block, overrides, permissionBaseline); }
      catch (error) {
        const index = (error as { callIndex?: number }).callIndex;
        if (index === undefined || steps[index]?.kind !== "approve" || !permissionBaseline.some(p => p.baseline !== "0" && same(p.token, steps[index]!.to))) throw error;
        steps.splice(index, 0, makeStep("approve-zero", steps[index]!.to, steps[index]!.abiFragment, [steps[index]!.args[0]!, "0"]));
        checked = await entryPreview(i, a.wallet, amount, steps, this.rpc, block, overrides, permissionBaseline);
      }
      const gas = checked.sim.calls.slice(0, steps.length).reduce((s, c) => s + BigInt(c.gasUsed) * 2n + 100000n, 0n) * base.gasPrice;
      const ethUsdMicros = await ethUsdPrice(i.chain, this.rpc, block);
      const checks = runChecks(i, BigInt(amount), evidence, { now, ethUsdMicros, exitPass: checked.preview.exitPreview.pass, entryPass: checked.assertions.every(c => c.pass), allowanceZero: checked.preview.allowanceAfter.atomic === "0", gasWei: gas, ethBalance: dryRun ? 10n ** 16n : base.eth });
      if (!dryRun && base.asset < BigInt(amount)) checks.refusals.push(refusal("INSUFFICIENT_BALANCE", "The wallet does not hold the plan's asset amount."));
      if (checks.refusals.length) return { ...checks, verdict: "refused" as const, preview: checked.preview, assertions: checked.assertions, text: `No plan was signed. ${checks.refusals.map(r => `${r.reason} ${r.next}`).join(" ")}` };
      const unsigned = { v: 1, id, chain: a.chain, wallet: a.wallet, family: a.family, contract: i.contract, asset: i.asset, amount: value(amount, i.assetDecimals), minReceive: value(checked.minimum, i.receiptDecimals), exitClass, ...(a.acceptExit ? { acceptExit: a.acceptExit } : {}), steps, exit: { kind: exitClass, steps: checked.exit, detail: checked.preview.exitPreview.detail }, baseline: { block: BigInt(block).toString(), position: value(base.position, i.receiptDecimals), allowance: value(originalAllowance, i.assetDecimals), assetBalance: value(base.asset, i.assetDecimals) }, createdAt: new Date(now).toISOString(), createdAtBlock: BigInt(block).toString(), expiresAt: new Date(now + 1800000).toISOString(), execution: { mode: "enter", receiptToken: i.receiptToken, assetDecimals: i.assetDecimals, receiptDecimals: i.receiptDecimals, slippageBps: a.slippageBps, permissions: permissionBaseline, expectedApprovals: steps.length, ...(opts.halfWidthTicks ? { halfWidthTicks: opts.halfWidthTicks } : {}) } };
      const exitWords = `Exit simulated just now at block ${BigInt(checked.preview.exitPreview.block)}: you'd get ${checked.preview.exitPreview.returns.map(r => `${r.amount.display} ${symbolOf(a.chain, r.token)}`).join(" + ") || "nothing"} back. ${checked.preview.exitPreview.detail}`;
      const text = dryRun ? `SIMULATED (balances overridden). No proposal or signed plan. ${planSummary(unsigned as Plan, exitWords)}` : `${planSummary(unsigned as Plan, exitWords)} ${planInstructions}`;
      return { verdict: "ok" as const, ...(dryRun ? {} : { plan: signPlan(unsigned, this.config.planKey, now) }), preview: checked.preview, checks: checks.checks, refusals: [], assertions: checked.assertions, costEstimate: { gasEth: value(gas, 18), gasUsd: value(gas * ethUsdMicros / 10n ** 18n, 6), detail: "ASSUMED conservative gas headroom; PayBox and the final transaction receipt determine the actual fee." }, text };
    } catch (error) { const r = refusalFrom(codeOf(error), error); return { verdict: "refused" as const, refusals: [r], text: `No plan or proposal was created. ${r.reason} ${r.next}` }; }
  }
  async dryRun(input: unknown) {
    const raw = input as Record<string, unknown>;
    return this.enter({ ...raw, wallet: raw.wallet ?? addr("0x000000000000000000000000000000000000d177") }, true);
  }
  async step(input: unknown) {
    try {
      const a = stepInputSchema.parse(input), plan = verifyPlan(a.plan, this.config.planKey, this.now()); assertWallet(plan, a.wallet);
      if (!plan.execution) throw new Error("PLAN_TAMPERED");
      let block = await this.rpc.call<Hex>("eth_blockNumber", []);
      const i = await this.identity(plan, plan.wallet, block);
      const progress = await reconcile(plan, a.txHashes as Hex[], i, this.rpc);
      if (progress.refusals.length) return { done: false, refusals: progress.refusals, progress, text: `Nothing was proposed. ${progress.refusals.map(r => `${r.reason} ${r.next}`).join(" ")}` };
      let index = -1;
      for (let n = 0; n < plan.steps.length; n++) {
        if (progress.completed.includes(n)) continue;
        const step = plan.steps[n]!;
        if (step.kind === "revoke") { const allowance = await read(this.rpc, step.to, f.allowance, [plan.wallet, step.args[0]], block) as bigint; if (allowance === 0n) continue; }
        index = n; break;
      }
      if (index < 0) return { done: true, refusals: [], progress, text: `Every step of this plan is confirmed onchain. Call ditto_verify with the plan and all its transaction hashes for the proof card.` };
      const next = plan.steps[index]!;
      const required = plan.steps.slice(0, index).map((s, n) => ({ s, n })).filter(({ s }) => ["bind", "approve", "approve-zero"].includes(s.kind));
      if (required.some(({ n }) => !progress.completed.includes(n))) return { done: false, refusals: [refusal("NOT_BOUND")], progress, text: `Nothing was proposed. ${refusal("NOT_BOUND").reason} ${refusal("NOT_BOUND").next}` };
      // Simulate on top of this plan's latest confirmed step: a load-balanced node can lag the one that returned the
      // receipt. Re-read the head once; if it is still behind, ask the agent to retry instead of refusing the plan.
      const lastConfirmed = progress.matches.reduce((m, x) => BigInt(x.receipt.blockNumber) > m ? BigInt(x.receipt.blockNumber) : m, 0n);
      if (lastConfirmed > BigInt(block)) block = await this.rpc.call<Hex>("eth_blockNumber", []);
      if (lastConfirmed > BigInt(block)) { const r = refusal("WAIT_PENDING", "The chain view Ditto reads has not caught up with your last confirmed transaction yet.", "Ask for the next step again in a few seconds. Do not resend anything."); return { done: false, refusals: [r], progress, text: `Nothing was proposed. ${r.reason} ${r.next}` }; }
      if (plan.execution.mode === "enter" && !["bind", "revoke"].includes(next.kind)) {
        const fresh = await this.enterPreviewForRemaining(plan, i, progress, block);
        if (fresh.refusals.length) return { done: false, ...fresh, progress, text: `Nothing was proposed: current checks no longer pass. ${fresh.refusals.map(r => `${r.reason} ${r.next}`).join(" ")}` };
      }
      const sim = await simulate(this.rpc, [asCall(next, plan.wallet)], { block });
      const [eth, price, estimate] = await this.rpc.batch<Hex>([{ method: "eth_getBalance", params: [plan.wallet, block] }, { method: "eth_gasPrice", params: [] }, { method: "eth_estimateGas", params: [asCall(next, plan.wallet)] }]);
      if (BigInt(eth!) < BigInt(estimate!) * BigInt(price!) * 2n + BigInt(next.value)) return { done: false, refusals: [refusal("INSUFFICIENT_GAS")], text: `Nothing was proposed. ${refusal("INSUFFICIENT_GAS").reason} ${refusal("INSUFFICIENT_GAS").next}` };
      const gasWei = BigInt(estimate!) * BigInt(price!);
      let gasUsd: string | undefined; try { const usd = gasWei * await ethUsdPrice(plan.chain, this.rpc, block) / 10n ** 18n; gasUsd = usd < 1000n ? "0.001" : value(usd, 6).display.replace(/0+$/, "").replace(/\.$/, ""); } catch { /* Gas in dollars is optional text. */ }
      return { done: false, index, total: plan.steps.length, step: next, transaction: { chain: plan.chain, ...encodeStep(next) }, simulated: sim, refusals: [], progress, text: `${describeStep(plan, next, index, plan.steps.length, gasUsd)} Select PayBox wallet ${plan.wallet}. ${planInstructions}` };
    } catch (error) { const r = refusalFrom(codeOf(error), error); return { done: false, refusals: [r], text: `Nothing was proposed. ${r.reason} ${r.next}` }; }
  }
  async enterPreviewForRemaining(plan: Plan, i: Identity, progress: Progress, block: Hex) {
    const evidence = await this.config.evidence(i, this.rpc, block, this.now());
    // Re-simulate only unconfirmed steps, so an already executed LP swap is not replayed.
    const remaining = plan.steps.filter((_, n) => !progress.completed.includes(n));
    const base = await this.baseline(i, plan.wallet, block);
    try {
      const checked = await entryPreview(i, plan.wallet, plan.amount.atomic, remaining, this.rpc, block, undefined, plan.execution!.permissions);
      const gas = checked.sim.calls.slice(0, remaining.length).reduce((s, c) => s + BigInt(c.gasUsed) * 2n + 100000n, 0n) * base.gasPrice;
      return runChecks(i, BigInt(plan.amount.atomic), evidence, { now: this.now(), ethUsdMicros: await ethUsdPrice(i.chain, this.rpc, block), exitPass: checked.preview.exitPreview.pass, entryPass: checked.assertions.every(c => c.pass), allowanceZero: checked.preview.allowanceAfter.atomic === "0", gasWei: gas, ethBalance: base.eth });
    } catch { return { checks: [], refusals: [refusal("SIM_FAILED", "The remaining entry and exit round trip failed in the current block.")], verdict: "refused" as const }; }
  }
}

export const exitInputSchema = targetSchema.extend({ wallet: addressSchema, amount: z.string().max(128).default("all"), tokenId: z.string().regex(/^[1-9][0-9]*$/).optional(), acceptExit: z.enum(["queued", "market"]).optional() }).strict();
export async function buildExitPlan(engine: ExecutionEngine, input: unknown) {
  try {
    const a = exitInputSchema.parse(input), block = await engine.rpc.call<Hex>("eth_blockNumber", []), now = engine.now();
    const i = await engine.identity(a, a.wallet, block);
    if (a.tokenId) i.details.tokenId = a.tokenId;
    const position = await recipes[i.family]!.position(i, a.wallet, engine.rpc);
    if (BigInt(position.balance.atomic) === 0n) { const r = refusal("INSUFFICIENT_BALANCE", "This wallet holds nothing in this market to exit.", "Check ditto_positions for what the wallet holds."); return { verdict: "refused", refusals: [r], text: `No exit plan was signed. ${r.reason} ${r.next}` }; }
    if (!position.exitPreview.pass) { const r = refusal("EXIT_FAILS", "Taking this position out fails in a simulation of the current block.", "Try again shortly; if it keeps failing the market may be short of cash. Nothing was proposed."); return { verdict: "refused", refusals: [r], text: `No exit plan was signed. ${r.reason} ${r.next}` }; }
    const base = await engine.baseline(i, a.wallet, block), id = planHash({ ...a, block, now, nonce: randomBytes(16).toString("hex") });
    const exitClass = position.exitPreview.exitClass;
    if (exitClass !== "instant" && a.acceptExit !== exitClass) throw new Error("EXIT_NOT_ACCEPTED");
    const all = a.amount === "all", amount = all ? position.valueNow.atomic : atomicAmount(a.amount, i.assetDecimals);
    if (BigInt(amount) <= 0n || BigInt(amount) > BigInt(position.valueNow.atomic)) throw new Error("INSUFFICIENT_BALANCE");
    // previewWithdraw rounds up; never ask to redeem more shares than the wallet holds.
    let shares = all ? position.balance.atomic : i.family === "erc4626" ? String(((s: bigint) => s > BigInt(position.balance.atomic) ? BigInt(position.balance.atomic) : s)(await read(engine.rpc, i.contract, "function previewWithdraw(uint256) view returns (uint256)", [amount], block) as bigint)) : amount;
    if (i.family === "lp-v3" && !all) throw new Error("AMOUNT_OVER_LIMIT");
    const opts: BuildOptions = { positionBalance: position.balance.atomic, shares: i.family !== "moonwell" || all, allowance: "0", ...(a.acceptExit ? { acceptExit: a.acceptExit } : {}), now };
    if (i.family === "lp-v3") {
      const data = await read(engine.rpc, i.receiptToken, positionFragment(i.details.protocol === "uniswap"), [a.tokenId], block) as readonly unknown[];
      Object.assign(opts, { tokenId: a.tokenId, liquidity: String(data[7]), min0: "0", min1: "0" });
      const { amountsForLiquidity } = await import("../recipes/lp-math.js");
      const amounts = amountsForLiquidity(BigInt(String(i.details.sqrtPriceX96)), Number(data[5]), Number(data[6]), data[7] as bigint);
      opts.min0 = (amounts.amount0 * 9950n / 10000n).toString(); opts.min1 = (amounts.amount1 * 9950n / 10000n).toString();
    }
    const exits = recipes[i.family]!.buildExit(i, a.wallet, i.family === "lp-v3" ? "all" : shares, opts), steps = [engine.bind(id, a.wallet), ...exits];
    const sim = await simulate(engine.rpc, steps.map(s => asCall(s, a.wallet)), { block });
    const permissionsBaseline = await Promise.all(permissions(steps).map(async p => ({ ...p, baseline: String(await read(engine.rpc, p.token, f.allowance, [a.wallet, p.spender], block)) })));
    const unsigned = { v: 1, id, chain: a.chain, wallet: a.wallet, family: i.family, contract: i.contract, asset: i.asset, amount: value(amount, i.assetDecimals), minReceive: value(exitClass === "instant" ? exitMinimum(i.family, BigInt(amount)) : 1n, i.assetDecimals), exitClass, ...(a.acceptExit ? { acceptExit: a.acceptExit } : {}), steps, exit: { kind: exitClass, steps: exits, detail: position.exitPreview.detail }, baseline: { block: BigInt(block).toString(), position: value(position.balance.atomic, i.receiptDecimals), allowance: value("0", i.assetDecimals), assetBalance: value(base.asset, i.assetDecimals) }, createdAt: new Date(now).toISOString(), createdAtBlock: BigInt(block).toString(), expiresAt: new Date(now + 1800000).toISOString(), execution: { mode: "exit", receiptToken: i.receiptToken, assetDecimals: i.assetDecimals, receiptDecimals: i.receiptDecimals, slippageBps: 50, permissions: permissionsBaseline, shares, ...(a.tokenId ? { tokenId: a.tokenId, lpMin0: opts.min0, lpMin1: opts.min1 } : {}), expectedApprovals: steps.length } };
    return { verdict: "ok", plan: signPlan(unsigned, engine.config.planKey, now), preview: sim, position, refusals: [], text: `${planSummary(unsigned as Plan, position.exitPreview.detail)}${i.family === "lp-v3" ? " After collection, you may separately choose swap-back to USDC; it is not automatic." : ""} ${planInstructions}` };
  } catch (e) { const r = refusalFrom(codeOf(e), e); return { verdict: "refused", refusals: [r], text: `No exit plan was signed. ${r.reason} ${r.next}` }; }
}
export const revokeInputSchema = targetSchema.extend({ wallet: addressSchema, token: addressSchema, spender: addressSchema }).strict();
export async function buildRevokePlan(engine: ExecutionEngine, raw: unknown) {
  try {
    const input = revokeInputSchema.parse(raw);
    const block = await engine.rpc.call<Hex>("eth_blockNumber", []), now = engine.now(), i = await engine.identity(input, input.wallet, block);
    const permitted = same(input.spender, i.contract) || [i.details.npm, i.details.router, i.details.queue].some(s => typeof s === "string" && same(s, input.spender));
    const tokenAllowed = [i.asset, i.receiptToken, i.details.token0, i.details.token1].some(t => typeof t === "string" && same(t, input.token));
    if (!i.provenance.verified || !permitted || !tokenAllowed) throw new Error("UNKNOWN_PROVENANCE");
    const allowance = await read(engine.rpc, input.token, f.allowance, [input.wallet, input.spender], block) as bigint;
    if (!allowance) return { done: true, text: "This permission is already zero." };
    const id = planHash({ ...input, now, block }), steps = [engine.bind(id, input.wallet), makeStep("revoke", input.token, "function approve(address spender,uint256 amount) returns (bool)", [input.spender, "0"])];
    const base = await engine.baseline(i, input.wallet, block), exitClass = i.family === "lst" ? "queued" : i.family === "lp-v3" ? "market" : "instant";
    const plan = signPlan({ v: 1, id, chain: i.chain, wallet: input.wallet, family: i.family, contract: i.contract, asset: i.asset, amount: value("0", i.assetDecimals), minReceive: value("0", i.receiptDecimals), exitClass, ...(exitClass !== "instant" ? { acceptExit: exitClass } : {}), steps, exit: { kind: exitClass, steps: [], detail: "Reset a leftover token permission; no position is moved." }, baseline: { block: BigInt(block).toString(), position: value(base.position, i.receiptDecimals), allowance: value(allowance, i.assetDecimals), assetBalance: value(base.asset, i.assetDecimals) }, createdAt: new Date(now).toISOString(), createdAtBlock: BigInt(block).toString(), expiresAt: new Date(now + 1800000).toISOString(), execution: { mode: "revoke", receiptToken: i.receiptToken, assetDecimals: i.assetDecimals, receiptDecimals: i.receiptDecimals, slippageBps: 0, permissions: [{ token: input.token, spender: input.spender, baseline: allowance.toString() }], expectedApprovals: 2 } }, engine.config.planKey, now);
    return { plan, verdict: "ok", text: `Expected PayBox approvals: 2, including wallet binding. ${planInstructions}` };
  } catch (e) { const r = refusalFrom(codeOf(e), e); return { verdict: "refused", refusals: [r], text: `No revoke plan was signed. ${r.reason} Only a verified recipe's own leftover permission can be reset.` }; }
}
// A swap-back is a separate, user-chosen plan AFTER the exit has collected tokens.
// Its amount comes only from the parent plan's confirmed exit receipts, never an
// existing wallet balance, and it cannot be requested by the normal exit path.
export async function buildSwapBackPlan(engine: ExecutionEngine, input: { plan: unknown; wallet: Address; txHashes: Hex[]; chooseSwapBack: true }) {
  try {
    if (input.chooseSwapBack !== true) throw new Error("EXIT_NOT_ACCEPTED");
    const parent = verifyPlan(input.plan, engine.config.planKey, engine.now()); assertWallet(parent, input.wallet);
    if (parent.family !== "lp-v3" || parent.execution?.mode !== "exit") throw new Error("PLAN_TAMPERED");
    const block = await engine.rpc.call<Hex>("eth_blockNumber", []), i = await engine.identity(parent, parent.wallet, block), p = await reconcile(parent, input.txHashes, i, engine.rpc);
    if (p.refusals.length || !parent.steps.every((_, n) => p.completed.includes(n))) return { verdict: "refused", refusals: p.refusals.length ? p.refusals : [refusal("NOT_BOUND", "Confirm the parent exit before choosing its swap-back.")], text: planInstructions };
    const token = addr(String(same(String(i.details.token0), parent.asset) ? i.details.token1 : i.details.token0));
    const transfers = p.matches.filter(m => parent.steps[m.index]!.kind === "exit").flatMap(m => m.receipt.logs);
    const { parseTokenTransfers } = await import("../simulate.js");
    const collected = parseTokenTransfers(transfers).filter(t => same(t.token, token) && same(t.to, parent.wallet)).reduce((s, t) => s + BigInt(t.amount), 0n);
    if (collected <= 0n) return { done: true, text: "The exit collected no second token, so no swap-back is needed." };
    const quote = await prepareLpSwap(i, parent.wallet, token, collected.toString(), engine.rpc, { acceptExit: "market", block, now: engine.now() });
    const now = engine.now(), id = planHash({ parent: parent.id, collected: collected.toString(), block, now }), steps = [engine.bind(id, parent.wallet), ...quote.steps];
    await simulate(engine.rpc, steps.map(s => asCall(s, parent.wallet)), { block });
    const base = await engine.baseline(i, parent.wallet, block);
    const plan = signPlan({ v: 1, id, chain: parent.chain, wallet: parent.wallet, family: parent.family, contract: parent.contract, asset: token, amount: value(collected, 18), minReceive: value(BigInt(quote.quote.amountOut) * 9950n / 10000n, 6), exitClass: "market", acceptExit: "market", steps, exit: { kind: "market", steps: [], detail: "User-chosen swap of this exit's collected WETH back to USDC." }, baseline: { block: BigInt(block).toString(), position: value("0", 0), allowance: value("0", 18), assetBalance: value(String(await read(engine.rpc, token, f.balance, [parent.wallet], block)), 18) }, createdAt: new Date(now).toISOString(), createdAtBlock: BigInt(block).toString(), expiresAt: new Date(now + 1800000).toISOString(), execution: { mode: "swap-back", receiptToken: i.receiptToken, assetDecimals: 18, receiptDecimals: 0, slippageBps: 50, permissions: permissions(steps).map(p => ({ ...p, baseline: "0" })), expectedApprovals: steps.length, parentPlanId: parent.id } }, engine.config.planKey, now);
    return { verdict: "ok", plan, text: `Optional swap-back you chose: expected PayBox approvals ${steps.length}. Only the parent exit's collected WETH is used. ${planInstructions}` };
  } catch(e) { const r = refusalFrom(codeOf(e), e); return { verdict: "refused", refusals: [r], text: `No swap-back plan was signed. ${r.reason} ${r.next}` }; }
}
