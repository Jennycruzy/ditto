import type { Hex } from "viem";
import type { Chain } from "../chains.js";
import provenance from "../provenance.json" with { type: "json" };
import { addr, read, reads, ZERO } from "../recipes/shared.js";
import type { Rpc } from "../rpc.js";
// Official provider/asset deployment source:
// https://github.com/bgd-labs/aave-address-book/tree/main/src
export async function ethUsdPrice(chain: Chain, rpc: Rpc, block: Hex): Promise<bigint> {
  const provider = chain === "ethereum" ? "0x2f39d218133afab8f2b819b1066c7e434ad94e9e" : provenance.aave[chain].provider;
  const weth = chain === "ethereum" ? "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" : chain === "arbitrum" ? "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" : "0x4200000000000000000000000000000000000006";
  const oracle = await read(rpc, addr(provider), "function getPriceOracle() view returns (address)", [], block) as `0x${string}`;
  const [currency, unit, price] = await reads(rpc, [{ to: oracle, fragment: "function BASE_CURRENCY() view returns (address)" }, { to: oracle, fragment: "function BASE_CURRENCY_UNIT() view returns (uint256)" }, { to: oracle, fragment: "function getAssetPrice(address) view returns (uint256)", args: [addr(weth)] }], block) as [string, bigint, bigint];
  if (currency !== ZERO || unit !== 100_000_000n || price <= 0n) throw new Error("RPC_UNAVAILABLE: USD oracle unit or price unavailable");
  return price * 1_000_000n / unit;
}
