import { getAddress } from "viem";

export type Chain = "base" | "arbitrum" | "optimism" | "ethereum";
// Native ETH is represented separately from token contract addresses.
export const NATIVE = "native" as const;
export const chains = {
  base: { id: 8453, host: "base-mainnet.g.alchemy.com", publicRpc: "https://mainnet.base.org", explorer: "https://basescan.org", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  arbitrum: { id: 42161, host: "arb-mainnet.g.alchemy.com", publicRpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  optimism: { id: 10, host: "opt-mainnet.g.alchemy.com", publicRpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io", usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85" },
  ethereum: { id: 1, host: "eth-mainnet.g.alchemy.com", publicRpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
} as const;

export function chainConfig(chain: Chain) {
  if (!Object.hasOwn(chains, chain)) throw new Error("CHAIN_UNSUPPORTED");
  return chains[chain];
}
export function rpcUrl(chain: Chain) { return `https://${chainConfig(chain).host}/v2`; }
export function usdcAddress(chain: Exclude<Chain, "ethereum">) { return getAddress(chains[chain].usdc); }
export function txLink(chain: Chain, hash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid transaction hash");
  return `${chainConfig(chain).explorer}/tx/${hash}`;
}
