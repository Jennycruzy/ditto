import type { Address } from "viem";
import provenance from "../provenance.json" with { type: "json" };
import { fragments, events } from "../abis.js";
import { makeStep } from "../encoding.js";
import { addr, approvals, basicPosition, expectations, f, MAX, parseEvents, positive, read, reads, requireIdentity, same, ZERO } from "./shared.js";
import type { Recipe } from "./types.js";

export const compoundV3: Recipe = {
  family: "compound-v3", chains: ["base", "arbitrum", "optimism"],
  async identify(contract, chain, rpc, options = {}) {
    if (chain === "ethereum") return null;
    const registry = provenance.compound[chain];
    const [factory, asset, paused, withdrawPaused, decimals, total] = await reads(rpc, [
      { to: addr(registry.configurator), fragment: "function factory(address) view returns (address)", args: [contract] },
      { to: contract, fragment: "function baseToken() view returns (address)" },
      { to: contract, fragment: "function isSupplyPaused() view returns (bool)" },
      { to: contract, fragment: "function isWithdrawPaused() view returns (bool)" },
      { to: contract, fragment: f.decimals }, { to: contract, fragment: "function totalSupply() view returns (uint256)" },
    ], options.block) as [Address, Address, boolean, boolean, number, bigint];
    if (same(factory, ZERO) || (options.asset && !same(asset, options.asset))) return null;
    const borrowBalance = options.wallet ? await read(rpc, contract, "function borrowBalanceOf(address) view returns (uint256)", [options.wallet], options.block) as bigint : null;
    return { family: "compound-v3", chain, contract, asset: addr(asset), receiptToken: contract, assetDecimals: Number(decimals), receiptDecimals: Number(decimals), totalAssets: total.toString(), paused, cap: MAX, provenance: { verified: true, source: provenance.compound.source, registry: addr(registry.configurator) }, details: { withdrawPaused, wallet: options.wallet ?? "unread", borrowBalance: borrowBalance?.toString() ?? "unread" } };
  },
  buildEnter(i, wallet, amount, options = {}) { requireIdentity(i, "compound-v3"); positive(amount); if (!same(String(i.details.wallet), wallet) || i.details.borrowBalance !== "0") throw new Error("SIM_FAILED: read and rule out existing base-token debt for this wallet"); return [...approvals(i.asset as Address, i.contract, amount, options), makeStep("enter", i.contract, fragments.cometSupply, [i.asset, amount])]; },
  buildExit(i, _wallet, amount, options = {}) { requireIdentity({ ...i, paused: false }, "compound-v3"); if (i.details.withdrawPaused) throw new Error("PAUSED"); if (amount !== "all" && (!options.positionBalance || positive(amount) > BigInt(options.positionBalance))) throw new Error("INSUFFICIENT_BALANCE"); return [makeStep("exit", i.contract, fragments.cometWithdraw, [i.asset, amount === "all" ? MAX : positive(amount).toString()])]; },
  expect(i, wallet, amount) { return expectations(i, wallet, amount, (positive(amount) > 2n ? positive(amount) - 2n : 0n).toString()); },
  recognise(receipt, ctx) { return parseEvents(receipt, ctx, "compound-v3", [{ event: events.cometSupply, kind: "enter", actor: "dst", amount: "amount" }, { event: events.cometWithdraw, kind: "exit", actor: "src", amount: "amount" }]); },
  position(i, wallet, rpc) { return basicPosition(i, wallet, rpc, async balance => balance, balance => compoundV3.buildExit(i, wallet, balance, { positionBalance: balance })); },
};
