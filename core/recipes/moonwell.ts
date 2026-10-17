import type { Address } from "viem";
import provenance from "../provenance.json" with { type: "json" };
import { fragments, events } from "../abis.js";
import { makeStep } from "../encoding.js";
import { addr, approvals, basicPosition, expectations, f, MAX, parseEvents, positive, read, reads, requireIdentity, same } from "./shared.js";
import type { Recipe } from "./types.js";

export const moonwell: Recipe = {
  family: "moonwell", chains: ["base", "optimism"],
  async identify(contract, chain, rpc, options = {}) {
    if (chain !== "base" && chain !== "optimism") return null;
    const registry = provenance.moonwell[chain];
    const [markets, asset, paused, comptroller, decimals, total, exchangeRate] = await reads(rpc, [
      { to: addr(registry.comptroller), fragment: "function getAllMarkets() view returns (address[])" },
      { to: contract, fragment: "function underlying() view returns (address)" },
      { to: addr(registry.comptroller), fragment: "function mintGuardianPaused(address) view returns (bool)", args: [contract] },
      { to: contract, fragment: "function comptroller() view returns (address)" }, { to: contract, fragment: f.decimals },
      { to: contract, fragment: "function totalSupply() view returns (uint256)" }, { to: contract, fragment: "function exchangeRateStored() view returns (uint256)" },
    ], options.block) as [Address[], Address, boolean, Address, number, bigint, bigint];
    if (!markets.some(m => same(m, contract)) || !same(comptroller, registry.comptroller) || (options.asset && !same(options.asset, asset))) return null;
    const assetDecimals = Number(await read(rpc, asset, f.decimals, [], options.block));
    return { family: "moonwell", chain, contract, asset: addr(asset), receiptToken: contract, assetDecimals, receiptDecimals: Number(decimals), totalAssets: (total * exchangeRate / 10n ** 18n).toString(), paused, cap: MAX, provenance: { verified: true, source: provenance.moonwell.source, registry: addr(registry.comptroller) }, details: { exchangeRate: exchangeRate.toString() } };
  },
  buildEnter(i, _wallet, amount, options = {}) { requireIdentity(i, "moonwell"); positive(amount); return [...approvals(i.asset as Address, i.contract, amount, options), makeStep("enter", i.contract, fragments.mint, [amount])]; },
  buildExit(i, _wallet, amount, options = {}) { requireIdentity({ ...i, paused: false }, "moonwell"); const all = amount === "all"; if (all) { if (!options.positionBalance) throw new Error("Read the wallet's mToken balance before building its exit"); amount = options.positionBalance; } return [makeStep("exit", i.contract, all || options.shares ? fragments.redeemCToken : fragments.redeemUnderlying, [positive(amount).toString()])]; },
  expect(i, wallet, amount, sim) { const expected = expectations(i, wallet, amount, "1"); expected.push({ kind: "return-code", amount: { atomic: "0", display: "0" } }); return expected; },
  recognise(receipt, ctx) { return parseEvents(receipt, ctx, "moonwell", [{ event: events.moonwellMint, kind: "enter", actor: "minter", amount: "mintAmount", shares: "mintTokens" }, { event: events.moonwellRedeem, kind: "exit", actor: "redeemer", amount: "redeemAmount", shares: "redeemTokens" }]); },
  position(i, wallet, rpc) { return basicPosition(i, wallet, rpc, async balance => balance * (await read(rpc, i.contract, "function exchangeRateStored() view returns (uint256)") as bigint) / 10n ** 18n, balance => moonwell.buildExit(i, wallet, balance, { shares: true })); },
};
