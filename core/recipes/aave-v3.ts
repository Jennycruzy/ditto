import type { Address } from "viem";
import provenance from "../provenance.json" with { type: "json" };
import { fragments, events } from "../abis.js";
import { usdcAddress } from "../chains.js";
import { makeStep } from "../encoding.js";
import { addr, approvals, basicPosition, expectations, f, MAX, parseEvents, positive, read, reads, requireIdentity, same, ZERO } from "./shared.js";
import type { Recipe } from "./types.js";

const reserve = "function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))";
export const normalizedIncomeFragment = "function getReserveNormalizedIncome(address) view returns (uint256)";
export function aaveMinimum(amount: bigint, index: bigint): bigint {
  const ray = 10n ** 27n;
  if (amount <= 0n || index < ray) throw new Error("SIM_FAILED");
  const expected = (amount * ray / index) * index / ray;
  const hardFloor = amount > 2n ? amount - 2n : 0n;
  return expected > hardFloor ? expected : hardFloor;
}
export const aaveV3: Recipe = {
  family: "aave-v3", chains: ["base", "arbitrum", "optimism"],
  async identify(contract, chain, rpc, options = {}) {
    if (chain === "ethereum") return null;
    const registry = provenance.aave[chain], block = options.block ?? "latest", asset = options.asset ?? usdcAddress(chain);
    const pool = await read(rpc, addr(registry.provider), "function getPool() view returns (address)", [], block) as Address;
    if (!same(contract, pool) || !same(pool, registry.pool)) return null;
    const [reserves, data, decimals, normalizedIncome] = await reads(rpc, [
      { to: pool, fragment: "function getReservesList() view returns (address[])" },
      { to: pool, fragment: reserve, args: [asset] }, { to: asset, fragment: f.decimals }, { to: pool, fragment: normalizedIncomeFragment, args: [asset] },
    ], block) as [Address[], Record<string, bigint | number | Address>, number, bigint];
    if (!reserves.some(a => same(a, asset))) return null;
    const config = data.configuration as bigint, receiptToken = addr(data.aTokenAddress as string);
    if (same(receiptToken, ZERO)) return null;
    const total = await read(rpc, receiptToken, "function totalSupply() view returns (uint256)", [], block) as bigint;
    const supplyCap = ((config >> 116n) & ((1n << 36n) - 1n)) * 10n ** BigInt(decimals);
    return { family: "aave-v3", chain, contract: pool, asset, receiptToken, assetDecimals: Number(decimals), receiptDecimals: Number(decimals), totalAssets: total.toString(),
      paused: (config & (1n << 56n)) === 0n || (config & ((1n << 57n) | (1n << 60n))) !== 0n,
      cap: supplyCap === 0n ? MAX : (supplyCap > total ? supplyCap - total : 0n).toString(),
      provenance: { verified: true, source: provenance.aave.source, registry: addr(registry.provider) }, details: { liquidityIndex: String(data.liquidityIndex), normalizedIncome: normalizedIncome.toString(), normalizedIncomeBlock: block === "latest" ? "unfixed" : BigInt(block).toString(), configuration: config.toString() } };
  },
  buildEnter(i, wallet, amount, options = {}) {
    requireIdentity(i, "aave-v3"); positive(amount);
    if (BigInt(amount) > BigInt(i.cap)) throw new Error("CAP_REACHED");
    return [...approvals(i.asset as Address, i.contract, amount, options), makeStep("enter", i.contract, fragments.aaveSupply, [i.asset, amount, wallet, 0])];
  },
  buildExit(i, wallet, amount) {
    requireIdentity({ ...i, paused: false }, "aave-v3");
    return [makeStep("exit", i.contract, fragments.aaveWithdraw, [i.asset, amount === "all" ? MAX : positive(amount).toString(), wallet])];
  },
  expect(i, wallet, amount, sim) {
    if (i.details.normalizedIncomeBlock !== sim.block) throw new Error("SIM_FAILED: read the income index in this simulated block");
    return expectations(i, wallet, amount, aaveMinimum(positive(amount), BigInt(String(i.details.normalizedIncome))).toString());
  },
  recognise(receipt, ctx) { return parseEvents(receipt, ctx, "aave-v3", [
    { event: events.aaveSupply, kind: "enter", actor: "onBehalfOf", amount: "amount", asset: "reserve" },
    { event: events.aaveWithdraw, kind: "exit", actor: "user", amount: "amount", asset: "reserve" },
    { event: events.aaveBorrow, kind: "other", actor: "onBehalfOf", amount: "amount", asset: "reserve" },
    { event: events.aaveRepay, kind: "other", actor: "user", amount: "amount", asset: "reserve" },
  ]); },
  position(i, wallet, rpc) { return basicPosition(i, wallet, rpc, async balance => balance, balance => aaveV3.buildExit(i, wallet, balance)); },
};
