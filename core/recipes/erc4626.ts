import type { Address } from "viem";
import provenance from "../provenance.json" with { type: "json" };
import { fragments, events } from "../abis.js";
import { usdcAddress } from "../chains.js";
import { makeStep } from "../encoding.js";
import { addr, approvals, basicPosition, expectations, f, minAfterSlip, parseEvents, positive, read, reads, requireIdentity, same } from "./shared.js";
import type { Identity, Recipe } from "./types.js";

export function assertVaultExecution(i: Identity) {
  requireIdentity(i, "erc4626");
  if (BigInt(String(i.details.sizeUsdMicros ?? "0")) < 100_000_000_000n) throw new Error("TOO_SMALL");
  if (i.provenance.listed !== true && i.provenance.named !== true) throw new Error("UNKNOWN_PROVENANCE");
}
export const erc4626: Recipe = {
  family: "erc4626", chains: ["base", "arbitrum", "optimism", "ethereum"],
  async identify(contract, chain, rpc, options = {}) {
    const block = options.block ?? "latest";
    const [asset, total, decimals] = await reads(rpc, [{ to: contract, fragment: f.asset }, { to: contract, fragment: f.totalAssets }, { to: contract, fragment: f.decimals }], block) as [Address, bigint, number];
    if (options.asset && !same(asset, options.asset)) return null;
    const [assetDecimals, cap, previewShares, previewAssets] = await reads(rpc, [{ to: asset, fragment: f.decimals }, { to: contract, fragment: f.maxDeposit, args: [options.wallet ?? contract] }, { to: contract, fragment: f.previewDeposit, args: [1n] }, { to: contract, fragment: f.convert, args: [10n ** BigInt(decimals)] }], block) as [number, bigint, bigint, bigint];
    const morpho = chain === "ethereum" ? [] : provenance.morpho[chain];
    const factories = [...morpho.map(v => ({ ...v, source: provenance.morpho.source })), ...(chain === "base" || chain === "arbitrum" ? [{ address: provenance.euler[chain], method: "isProxy", source: provenance.euler.source }] : [])];
    const matches = factories.length ? await reads(rpc, factories.map(factory => ({ to: addr(factory.address), fragment: `function ${factory.method}(address) view returns (bool)`, args: [contract] })), block) : [];
    const registry = factories.find((_, index) => matches[index] === true);
    const named = provenance.namedVaults.find(v => v.chain === chain && same(v.address, contract) && same(v.asset, asset));
    const listing = options.listing;
    // Listing is supplied only by the bounded data client, never copied from agent input.
    const listingAge = (options.now ?? Date.now()) - Date.parse(listing?.fetchedAt ?? "");
    const listed = !!listing && same(listing.address, contract) && listing.chain === chain && listing.listed && listingAge >= 0 && listingAge < 7_200_000;
    const isUsdc = chain !== "ethereum" && same(asset, usdcAddress(chain));
    const usdMicros = isUsdc ? total * 1_000_000n / 10n ** BigInt(assetDecimals) : 0n;
    return { family: "erc4626", chain, contract, asset: addr(asset), receiptToken: contract, assetDecimals: Number(assetDecimals), receiptDecimals: Number(decimals), totalAssets: total.toString(), paused: false, cap: cap.toString(), provenance: { verified: registry !== undefined || named !== undefined, source: named?.source ?? registry?.source ?? provenance.morpho.source, ...(registry ? { registry: addr(registry.address) } : {}), listed, sizeUsd: (usdMicros / 1_000_000n).toString(), named: named !== undefined }, details: { sizeUsdMicros: usdMicros.toString(), oneUnitShares: previewShares.toString(), sharePrice: previewAssets.toString(), capMode: registry?.method === "isVaultV2" ? "simulated-round-trip" : "maxDeposit" } };
  },
  buildEnter(i, wallet, amount, options = {}) {
    assertVaultExecution(i); positive(amount);
    if (i.details.capMode !== "simulated-round-trip" && BigInt(amount) > BigInt(i.cap)) throw new Error("CAP_REACHED");
    return [...approvals(i.asset as Address, i.contract, amount, options), makeStep("enter", i.contract, fragments.deposit, [amount, wallet])];
  },
  buildExit(i, wallet, shares, options = {}) {
    requireIdentity({ ...i, paused: false }, "erc4626");
    if (shares === "all") { if (!options.positionBalance) throw new Error("Read the wallet's share balance before building its exit"); shares = options.positionBalance; }
    return [makeStep("exit", i.contract, fragments.redeem, [positive(shares).toString(), wallet, wallet])];
  },
  expect(i, wallet, amount, sim) {
    if (i.details.previewFor !== amount || i.details.previewBlock !== sim.block) throw new Error("SIM_FAILED: read previewDeposit for this amount in the simulation");
    const shares = BigInt(String(i.details.previewShares));
    if (shares <= 0n) throw new Error("SIM_FAILED: previewDeposit returned zero shares");
    return expectations(i, wallet, amount, minAfterSlip(shares).toString());
  },
  recognise(receipt, ctx) { return parseEvents(receipt, ctx, "erc4626", [
    { event: events.deposit, kind: "enter", actor: "owner", amount: "assets", shares: "shares" },
    { event: events.withdraw, kind: "exit", actor: "owner", amount: "assets", shares: "shares" },
  ]); },
  position(i, wallet, rpc) { return basicPosition(i, wallet, rpc, async balance => await read(rpc, i.contract, f.convert, [balance]) as bigint, balance => erc4626.buildExit(i, wallet, balance)); },
};
