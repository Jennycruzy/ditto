import { toHex, type Address } from "viem";
import provenance from "../provenance.json" with { type: "json" };
import { fragments, events } from "../abis.js";
import { encodeStep, makeStep } from "../encoding.js";
import { parseTokenTransfers, simulate } from "../simulate.js";
import { addr, approvals, expectations, f, MAX, parseEvents, positive, read, reads, requireIdentity, same, value, ZERO } from "./shared.js";
import type { Recipe } from "./types.js";

export const lst: Recipe = {
  family: "lst", chains: ["ethereum"],
  async identify(contract, chain, rpc, options = {}) {
    if (chain !== "ethereum" || (!same(contract, provenance.lido.steth) && !same(contract, provenance.lido.wsteth))) return null;
    const steth = addr(provenance.lido.steth), wrapped = same(contract, provenance.lido.wsteth);
    const [paused, total, rate, queuePaused] = await reads(rpc, [
      { to: steth, fragment: "function isStakingPaused() view returns (bool)" },
      { to: steth, fragment: "function getTotalPooledEther() view returns (uint256)" },
      { to: steth, fragment: "function getPooledEthByShares(uint256) view returns (uint256)", args: [10n ** 18n] },
      { to: addr(provenance.lido.queue), fragment: "function isPaused() view returns (bool)" },
    ], options.block) as [boolean, bigint, bigint, boolean];
    if (wrapped && !same(await read(rpc, contract, "function stETH() view returns (address)", [], options.block) as string, steth)) return null;
    return { family: "lst", chain, contract, asset: wrapped ? steth : "native", receiptToken: contract, assetDecimals: 18, receiptDecimals: 18, totalAssets: total.toString(), paused, cap: MAX, provenance: { verified: true, source: provenance.lido.source }, details: { wrapped, shareRate: rate.toString(), queue: provenance.lido.queue, queuePaused } };
  },
  buildEnter(i, wallet, amount, options = {}) {
    requireIdentity(i, "lst"); positive(amount);
    if (options.acceptExit !== "queued") throw new Error("EXIT_NOT_ACCEPTED");
    if (i.details.queuePaused) throw new Error("PAUSED");
    return i.details.wrapped ? [...approvals(i.asset as Address, i.contract, amount, options), makeStep("enter", i.contract, fragments.wrap, [amount])] : [makeStep("enter", i.contract, fragments.submit, [ZERO], [], amount)];
  },
  buildExit(i, wallet, amount, options = {}) {
    requireIdentity({ ...i, paused: false }, "lst");
    if (options.acceptExit !== "queued") throw new Error("EXIT_NOT_ACCEPTED");
    if (i.details.queuePaused) throw new Error("PAUSED");
    if (amount === "all") { if (!options.positionBalance) throw new Error("Read the LST balance first"); amount = options.positionBalance; }
    const n = positive(amount), queue = addr(provenance.lido.queue);
    if (n < 100n || n > 1000n * 10n ** 18n) throw new Error("AMOUNT_OVER_LIMIT");
    return [...approvals(i.receiptToken, queue, amount, options), makeStep("exit", queue, i.details.wrapped ? fragments.requestWithdrawalsWstETH : fragments.requestWithdrawals, [[amount], wallet])];
  },
  expect(i, wallet, amount) { return expectations(i, wallet, amount, i.details.wrapped ? (positive(amount) * 10n ** 18n / BigInt(String(i.details.shareRate)) - 2n).toString() : (positive(amount) > 2n ? positive(amount) - 2n : 0n).toString()); },
  recognise(receipt, ctx) {
    const direct = parseEvents(receipt, ctx, "lst", [{ event: events.submitted, kind: "enter", actor: "sender", amount: "amount" }]);
    if (receipt.status !== "0x1") return [];
    const transfers = parseTokenTransfers(receipt.logs);
    for (const i of ctx.identities.filter(id => id.family === "lst" && id.chain === "ethereum" && id.details.wrapped)) {
      for (const t of transfers.filter(t => t.kind === "erc20" && same(t.token, i.receiptToken))) {
        const enter = same(t.from, ZERO), exit = same(t.to, ZERO);
        if (!enter && !exit) continue;
        const actor = enter ? t.to : t.from;
        const paired = transfers.find(p => p.kind === "erc20" && same(p.token, i.asset) && (enter ? same(p.from, actor) && same(p.to, i.contract) : same(p.to, actor) && same(p.from, i.contract)));
        if (paired) direct.push({ kind: enter ? "enter" : "exit", family: "lst", contract: i.contract, asset: i.asset, amount: paired.amount, actor, receiptAmount: t.amount, txHash: receipt.transactionHash });
      }
    }
    return direct;
  },
  async position(i, wallet, rpc) {
    const balance = await read(rpc, i.receiptToken, f.balance, [wallet]) as bigint;
    const assets = i.details.wrapped ? await read(rpc, i.contract, "function getStETHByWstETH(uint256) view returns (uint256)", [balance]) as bigint : balance;
    const queue = addr(provenance.lido.queue);
    let block = BigInt(await rpc.call<string>("eth_blockNumber", [])).toString(), pass = false, returns: { token: Address; amount: { atomic: string; display: string } }[] = [];
    if (balance >= 100n) {
      const steps = lst.buildExit(i, wallet, balance.toString(), { acceptExit: "queued" });
      const sim = await simulate(rpc, steps.map(s => ({ ...encodeStep(s), from: wallet, value: toHex(BigInt(s.value)) })));
      block = sim.block;
      const count = sim.calls.flatMap(c => c.transfers).filter(t => t.kind === "erc721" && same(t.token, queue) && same(t.to, wallet)).length;
      pass = count > 0; if (pass) returns = [{ token: queue, amount: value(String(count), 0) }];
    }
    return { family: "lst", chain: i.chain, contract: i.contract, wallet, receiptToken: i.receiptToken, amountIn: null, balance: value(balance, 18), valueNow: value(assets, 18), change: null, exitCandidateId: `${i.chain}:lst:${i.contract}`, exitPreview: { simulated: true, block, exitClass: "queued", returns, pass, detail: pass ? "Queue request simulated; the NFT represents a future claim. No instant ETH payment is claimed." : "ETH returns through a withdrawal queue, usually days. No instant ETH exit is claimed." } };
  },
};
