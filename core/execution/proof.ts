import { type Hex } from "viem";
import { verifyPlan } from "../plan.js";
import { simulate, parseTokenTransfers, walletDeltas } from "../simulate.js";
import { f, read, same, value, ZERO, exitMinimum } from "../recipes/shared.js";
import { recipes, aaveMinimum, normalizedIncomeFragment } from "../recipes/index.js";
import { proofSchema } from "../schemas.js";
import { txLink } from "../chains.js";
import { asCall } from "./preview.js";
import { reconcile } from "./progress.js";
import { refusal, refusalFrom } from "./types.js";
import { chainWords, short, symbolOf } from "./words.js";
import { codeOf } from "./engine.js";
import type { ExecutionEngine } from "./engine.js";
export async function verifyExecution(engine: ExecutionEngine, input: { plan: unknown; txHashes: Hex[] }) {
  try {
    const p = verifyPlan(input.plan, engine.config.planKey, engine.now()); if (!p.execution) throw new Error("PLAN_TAMPERED");
    const block = await engine.rpc.call<Hex>("eth_blockNumber", []), i = await engine.identity(p, p.wallet, block), progress = await reconcile(p, input.txHashes, i, engine.rpc);
    const assertions: { code: string; pass: boolean; detail: string }[] = [];
    const add = (code: string, pass: boolean, detail: string) => assertions.push({ code, pass, detail });
    add("TRANSACTIONS", !progress.refusals.length && p.steps.every((s, n) => s.kind === "revoke" || progress.completed.includes(n)), "Only this plan's confirmed, exact transactions count; positions already held do not count.");
    const matches = [...new Map(progress.matches.map(m => [m.hash, m])).values()], transfers = matches.flatMap(m => parseTokenTransfers(m.receipt.logs));
    const deltas = walletDeltas(transfers, p.wallet), mode = p.execution.mode;
    const outgoing = transfers.filter(t => same(t.token, p.asset) && same(t.from, p.wallet)).reduce((s, t) => s + BigInt(t.amount), 0n);
    const entered = matches.filter(m => p.steps[m.index]!.kind === "enter");
    const assetOut = p.asset === "native" ? entered.reduce((s, m) => s + BigInt(m.tx.value), 0n) : outgoing;
    if (mode === "enter") {
      add("ASSET_OUT", i.family === "lp-v3" ? assetOut > 0n && assetOut <= BigInt(p.amount.atomic) : assetOut === BigInt(p.amount.atomic), "The wallet's outgoing asset amount matches the plan.");
      let received = transfers.filter(t => same(t.token, i.receiptToken) && same(t.to, p.wallet)).reduce((s, t) => s + BigInt(t.amount), 0n);
      let minimum = BigInt(p.minReceive.atomic);
      if (i.family === "aave-v3" && entered[0]) minimum = aaveMinimum(BigInt(p.amount.atomic), await read(engine.rpc, i.contract, normalizedIncomeFragment, [i.asset], entered[0].receipt.blockNumber) as bigint);
      add("RECEIPT_IN", received >= minimum, "The receipt amount meets the minimum computed for the receipt block.");
      const current = await read(engine.rpc, i.receiptToken, f.balance, [p.wallet], block) as bigint;
      const nft = transfers.find(t => t.kind === "erc721" && same(t.token, i.receiptToken) && same(t.from, ZERO) && same(t.to, p.wallet));
      const ownerOk = i.family !== "lp-v3" || !!nft && same(await read(engine.rpc, i.receiptToken, "function ownerOf(uint256) view returns (address)", [nft.tokenId], block) as string, p.wallet);
      add("POSITION_DELTA", i.family === "lp-v3" ? ownerOk && current >= BigInt(p.baseline.position.atomic) + 1n : current >= BigInt(p.baseline.position.atomic) + minimum, "The current position increased by this plan's minimum, in addition to its baseline.");
    }
    const allowed = i.family === "lp-v3" ? [String(i.details.token0), String(i.details.token1), i.receiptToken] : [i.asset, i.receiptToken];
    add("NO_OTHER_OUT", transfers.filter(t => same(t.from, p.wallet)).every(t => allowed.some(a => same(a, t.token))), "No token outside the recipe left the wallet in these receipts.");
    const allowanceReads = await Promise.all(p.execution.permissions.map(async permission => ({ ...permission, amount: await read(engine.rpc, permission.token, f.allowance, [p.wallet, permission.spender], block) as bigint })));
    const allowance = allowanceReads.reduce((s, p) => s + p.amount, 0n);
    add("ALLOWANCE_ZERO", allowance === 0n, "Every plan permission is currently zero.");
    if (allowance > 0n) progress.refusals.push(refusal("ALLOWANCE_LEFT"));
    let exitPreview;
    if (mode === "enter" && entered.length === 1 && i.family !== "lp-v3" && i.family !== "lst") {
      const shares = transfers.filter(t => same(t.token, i.receiptToken) && same(t.to, p.wallet)).reduce((s, t) => s + BigInt(t.amount), 0n).toString();
      const steps = recipes[i.family]!.buildExit(i, p.wallet, shares, { shares: true, positionBalance: shares });
      const sim = await simulate(engine.rpc, steps.map(s => asCall(s, p.wallet)), { block });
      const returns = walletDeltas(sim.calls.flatMap(c => c.transfers), p.wallet).filter(d => same(d.token, i.asset) && BigInt(d.delta) > 0n);
      const pass = returns.reduce((s, r) => s + BigInt(r.delta), 0n) >= exitMinimum(i.family, BigInt(p.amount.atomic)) && (i.family !== "moonwell" || sim.calls.every(c => BigInt(c.returnData) === 0n));
      exitPreview = { simulated: true as const, block: sim.block, exitClass: "instant" as const, returns: returns.map(r => ({ token: r.token, amount: value(r.delta, i.assetDecimals) })), pass, detail: "The exit of this plan's receipt amount was simulated now; future liquidity can change." };
      add("EXIT_OPEN", pass, exitPreview.detail);
    } else if (mode === "enter") add("EXIT_CLASS", p.acceptExit === p.exitClass, `The accepted exit is ${p.exitClass}; instant ETH is not promised.`);
    if (mode === "exit" || mode === "swap-back") {
      const received = mode === "swap-back" ? transfers.filter(t => same(t.token, i.asset) && same(t.to, p.wallet)).reduce((s, t) => s + BigInt(t.amount), 0n) : deltas.filter(d => same(d.token, i.asset) && BigInt(d.delta) > 0n).reduce((s, d) => s + BigInt(d.delta), 0n);
      let passes = received >= BigInt(p.minReceive.atomic);
      if (p.family === "lp-v3" && mode === "exit") passes = [i.details.token0, i.details.token1].every((token, n) => transfers.filter(t => same(t.token, String(token)) && same(t.to, p.wallet)).reduce((s, t) => s + BigInt(t.amount), 0n) >= BigInt(n === 0 ? p.execution!.lpMin0 ?? "1" : p.execution!.lpMin1 ?? "1"));
      if (p.family === "lst" && mode === "exit") passes = transfers.some(t => t.kind === "erc721" && same(t.to, p.wallet) && typeof i.details.queue === "string" && same(t.token, i.details.queue));
      add("EXIT_RECEIVED", passes, "The confirmed exit honours its signed minimum and accepted exit class.");
    }
    const feesKnown = matches.every(m => m.receipt.gasUsed && m.receipt.effectiveGasPrice && (!(p.chain === "base" || p.chain === "optimism") || m.receipt.l1Fee !== undefined));
    add("GAS_PAID", feesKnown, "Gas is read from receipts, including the L1 fee on OP-stack chains; unavailable fields are not invented.");
    const gas = matches.reduce((s, m) => s + BigInt(m.receipt.gasUsed ?? "0x0") * BigInt(m.receipt.effectiveGasPrice ?? "0x0") + BigInt(m.receipt.l1Fee ?? "0x0"), 0n);
    const proof = proofSchema.parse({ planId: p.id, chain: p.chain, wallet: p.wallet, generatedAt: new Date(engine.now()).toISOString(), landed: assertions.every(a => a.pass) && !progress.refusals.length, txHashes: matches.map(m => m.hash), assertions, movements: transfers.filter(t => same(t.to, p.wallet) || same(t.from, p.wallet)).map(t => ({ token: t.token, amount: value(t.amount, same(t.token, i.receiptToken) ? i.receiptDecimals : same(t.token, i.asset) ? i.assetDecimals : 18) })), allowanceAfter: value(allowance, i.assetDecimals), gasPaid: feesKnown ? value(gas, 18) : null, ...(exitPreview ? { exitPreview } : {}), exitClass: p.exitClass, refusals: progress.refusals });
    // Proof card (SPEC §11.2): one line per assertion, with the amounts it checked.
    const sym = (token: string) => symbolOf(p.chain, token), amt = (atomic: bigint, decimals: number) => value(atomic, decimals).display;
    const receiptIn = transfers.filter(t => same(t.token, i.receiptToken) && same(t.to, p.wallet)).reduce((s, t) => s + BigInt(t.amount), 0n);
    const assetBack = transfers.filter(t => same(t.token, p.asset) && same(t.to, p.wallet)).reduce((s, t) => s + BigInt(t.amount), 0n);
    const enterHash = entered[0]?.hash ?? matches.at(-1)?.hash;
    const line: Record<string, string> = {
      TRANSACTIONS: `${matches.length} confirmed transaction${matches.length === 1 ? "" : "s"} from ${p.wallet} match this plan exactly`,
      ASSET_OUT: `${amt(assetOut, i.assetDecimals)} ${sym(p.asset)} left your wallet${enterHash ? ` (tx ${short(enterHash)})` : ""}`,
      RECEIPT_IN: i.family === "lp-v3" ? "The position NFT arrived in your wallet" : `${amt(receiptIn, i.receiptDecimals)} of the receipt token (${short(i.receiptToken)}) arrived (at least ${p.minReceive.display} required)`,
      POSITION_DELTA: "Your position grew by this plan's amount, on top of what you held before",
      NO_OTHER_OUT: "Nothing else left your wallet",
      ALLOWANCE_ZERO: "Allowance back to 0",
      EXIT_OPEN: exitPreview ? `Exit open: taking it all out now returns ${exitPreview.returns.map(r => `${r.amount.display} ${sym(r.token)}`).join(" + ") || "nothing"} (simulated just now)` : "Exit open",
      EXIT_CLASS: `Exit is ${p.exitClass}, as you accepted; instant cash back is not promised`,
      EXIT_RECEIVED: p.family === "lp-v3" ? "Both pool tokens came back to your wallet, at or above the signed minimums" : `${amt(assetBack, i.assetDecimals)} ${sym(p.asset)} came back to your wallet (at least ${p.minReceive.display} required)`,
      GAS_PAID: "Gas read from the receipts",
    };
    const card = [`Ditto proof · ${chainWords[p.chain]} · plan ${p.id.slice(0, 4)}…`, ...assertions.map(a => `${a.pass ? "✓" : "✗"} ${line[a.code] ?? a.detail}${a.pass ? "" : ` — ${a.detail}`}`), `Gas: ${feesKnown ? `${value(gas, 18).display.replace(/0+$/, "")} ETH` : "unavailable from these receipts"}`, ...progress.refusals.map(r => `${r.reason} ${r.next}`), ...matches.map(m => txLink(p.chain, m.hash))];
    return { proof, links: matches.map(m => txLink(p.chain, m.hash)), text: `${card.join("\n")}\n${proof.landed ? "Landed: every check passed onchain." : "Not complete: see the ✗ lines."}` };
  } catch (error) { const r = refusalFrom(codeOf(error), error); return { refusals: [r], text: `No proof card. ${r.reason} ${r.next}` }; }
}
