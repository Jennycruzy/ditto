import { getAddress, toHex } from "viem";
import { usdcAddress } from "../core/chains.js";
import { quote } from "../core/text.js";
import { TRANSFER_TOPIC, type Log } from "../core/simulate.js";

export const wallet = getAddress("0x000000000000000000000000000000000000d177");
export const other = getAddress("0x000000000000000000000000000000000000d178");
export const token = usdcAddress("base");
export const contract = getAddress("0x000000000000000000000000000000000000d179");
export const amount = (atomic = "1000000", display = "1.000000") => ({ atomic, display });
export const now = Date.parse("2026-10-17T18:00:00Z");
export const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
export const transfer = (n = 1n): Log => ({ address: token, topics: [TRANSFER_TOPIC, topic(wallet), topic(other)], data: toHex(n, { size: 32 }) });
export function unsignedPlan() {
  return {
    v: 1 as const, id: "a".repeat(64), chain: "base" as const, wallet, family: "aave-v3" as const,
    contract, asset: token, amount: amount(), minReceive: amount("999999", "0.999999"), exitClass: "instant" as const,
    steps: [{ kind: "approve" as const, to: token, value: "0", selector: "0x095ea7b3", abiFragment: "function approve(address spender, uint256 amount) returns (bool)", args: [contract, "1000000"], expect: [{ kind: "allowance" as const, token, account: wallet, spender: contract, amount: amount() }] }],
    exit: { kind: "instant" as const, steps: [], detail: "Exit must be simulated before entry." },
    baseline: { block: "100", position: amount("0", "0.000000"), allowance: amount("0", "0.000000"), assetBalance: amount() },
    createdAt: new Date(now).toISOString(), createdAtBlock: "100", expiresAt: new Date(now + 1_800_000).toISOString(),
  };
}
export function candidate() {
  return {
    id: "test", family: "erc4626" as const, protocol: quote("Sample"), contract, receiptToken: contract, chain: "base" as const,
    evidence: { window: "24h" as const, deposits: 5, uniqueWallets: 3, volumeAsset: amount(), lastSeenAgoSec: 1, sampleTxs: [] },
    metrics: { totalAssets: amount(), ageDays: 30 }, checks: [], exitClass: "instant" as const,
    rank: { score: 1, why: "Unit fixture; no chain claim." },
  };
}
export const exitPreview = () => ({ simulated: true as const, block: "101", exitClass: "instant" as const, returns: [{ token, amount: amount() }], pass: true, detail: "Unit fixture." });
