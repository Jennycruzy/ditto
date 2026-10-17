import type { Address, Hex } from "viem";
import type { Chain } from "../chains.js";
import type { Identity, Family } from "../recipes/types.js";
import type { RangeSample } from "../recognise/width.js";
import type { Rpc } from "../rpc.js";
import type { Check, Refusal, Plan } from "../schemas.js";
import { refusalWords } from "./words.js";
export type Evidence = {
  chain: Chain; contract: Address; generatedAt: string; deposits24h: number; uniqueWallets24h: number; firstSeen: string;
  sharePrices: { at: string; value: string }[]; lpRanges: RangeSample[]; volume24hUsd: string; incomplete: boolean;
};
export type EvidenceSource = (identity: Identity, rpc: Rpc, block: Hex, now: number) => Promise<Evidence>;
export type Target = { chain: Chain; family: Family; contract: Address };
export type Config = { planKey?: string; maxAmount?: string; now?: () => number; evidence: EvidenceSource; listing?: (address: Address, chain: Chain) => Promise<import("../recipes/types.js").IdentifyOptions["listing"] & { warnings?: string[] } | undefined> };
export type Checked = { checks: Check[]; refusals: Refusal[]; verdict: "ok" | "refused" };
export type Transaction = { hash: Hex; from: Address; to: Address | null; input: Hex; value: Hex; blockNumber: Hex | null; blockHash: Hex | null };
export type Executed = { hash: Hex; index: number; tx: Transaction; receipt: import("../recipes/types.js").Receipt & { gasUsed?: Hex; effectiveGasPrice?: Hex; l1Fee?: Hex } };
export type Progress = { matches: Executed[]; completed: number[]; pending: Hex[]; duplicateEnters: Hex[]; refusals: Refusal[]; incomplete: boolean };
export const planInstructions = "Pass this signed plan back unchanged. Select the PayBox wallet with the address shown in the plan and use approval mode ‘ask me’. After PayBox returns a request ID, poll get_request until success; do not request the same transaction again. When PayBox says success, call ditto_verify with the hash.";
export function refusal(code: Refusal["code"], reason = refusalWords[code].reason, next = refusalWords[code].next): Refusal { return { code, reason: reason.slice(0, 500), next }; }
// A thrown "CODE: detail" keeps its detail after the plain-words reason.
export function refusalFrom(code: Refusal["code"], error: unknown): Refusal {
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] })?.issues;
  if (Array.isArray(issues)) return refusal(code, `The request was not valid (${issues.slice(0, 4).map(i => `${i.path.map(String).join(".") || "input"}: ${i.message}`).join("; ")}).`, "Fix that field and ask again. Addresses are 0x plus 40 hex characters, all lowercase or correctly checksummed.");
  const detail = ((error as Error)?.message ?? "").replace(/^[A-Z_]+:?\s*/, "").trim();
  return refusal(code, detail && detail !== code ? `${refusalWords[code].reason} (${detail.slice(0, 200)})` : refusalWords[code].reason);
}
export const executionRpcBudgets = { plan: 96, step: 128, verify: 128, positions: 96, exitPlan: 96, dryRun: 96 } as const;
export type Signed = Plan;
