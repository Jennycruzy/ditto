import type { Chain } from "../chains.js";
import { usdcAddress } from "../chains.js";
import { same } from "../recipes/shared.js";
import type { Plan, Refusal, Step } from "../schemas.js";
// Plain words for every refusal (SPEC §10.2): why it happened and what to do next.
export const refusalWords: Record<Refusal["code"], { reason: string; next: string }> = {
  UNRECOGNISED: { reason: "Ditto can't rebuild this action yet.", next: "Pick a move from ditto_find, or explain a transaction from a supported protocol." },
  FAMILY_DISABLED: { reason: "This kind of move is not enabled in Ditto.", next: "Choose a lending, savings vault, staking or LP move from ditto_find." },
  ASSET_MISMATCH: { reason: "The contract does not hold the asset you asked for.", next: "Ask for the contract's own asset, or pick another candidate." },
  NOT_ENOUGH_USE: { reason: "Ditto could not see enough real use today (at least 5 deposits by 3 wallets in 24 hours).", next: "Pick a busier candidate from ditto_find, or try again later." },
  TOO_NEW: { reason: "This contract has less than 30 days of activity.", next: "Pick an older candidate from ditto_find." },
  TOO_SMALL: { reason: "This pool or vault holds less than $100,000.", next: "Pick a larger candidate from ditto_find." },
  SHARE_PRICE_DROP: { reason: "Its share price fell more than 0.5% in a day this week, or Ditto could not read seven days of prices.", next: "Pick another candidate; Ditto won't copy into a falling vault." },
  EXIT_FAILS: { reason: "Ditto won't put money in here: in the simulation, taking it back out failed or returned too little. Ditto only proposes moves you can undo.", next: "Pick another candidate from ditto_find." },
  PAUSED: { reason: "The protocol has paused or frozen this market.", next: "Pick another candidate, or try again after the protocol unpauses it." },
  CAP_REACHED: { reason: "The market's deposit cap is full for this amount.", next: "Try a smaller amount or another candidate." },
  FEE_ON_TRANSFER: { reason: "The simulated token amounts did not match the plan (a transfer fee or an unexpected token move).", next: "Pick another candidate; Ditto only signs plans whose token moves match exactly." },
  INSUFFICIENT_BALANCE: { reason: "Your wallet does not hold the amount this plan needs.", next: "Use a smaller amount or fund the wallet first." },
  INSUFFICIENT_GAS: { reason: "Your wallet does not have enough ETH to pay gas for this step.", next: "Add a little ETH on this chain, then ask for the step again." },
  AMOUNT_OVER_LIMIT: { reason: "The amount is above this deployment's limit.", next: "Use an amount at or below the limit shown by check_config." },
  PLAN_TAMPERED: { reason: "The plan was changed after Ditto signed it, or a transaction does not match it exactly.", next: "Pass the signed plan back unchanged, or build a fresh plan." },
  PLAN_EXPIRED: { reason: "This plan is older than 30 minutes.", next: "Build a fresh plan; Ditto will re-run every check." },
  WALLET_MISMATCH: { reason: "The wallet you passed is not the plan's wallet.", next: "Use the wallet address shown in the plan, and select that wallet in PayBox." },
  CHAIN_UNSUPPORTED: { reason: "Ditto does not support this chain.", next: "Use Base, Arbitrum, Optimism or Ethereum." },
  SIM_FAILED: { reason: "The step failed in a simulation of the current block.", next: "Build a fresh plan; nothing was proposed." },
  RPC_UNAVAILABLE: { reason: "Ditto could not read the chain completely just now.", next: "Try again in a moment; nothing was proposed." },
  EXIT_NOT_ACCEPTED: { reason: "Getting out of this move is not instant (a queue or a market sale), and you have not accepted that.", next: "Read the exit terms and ask again with acceptExit set to the exit class." },
  UNKNOWN_PROVENANCE: { reason: "Ditto can't confirm who deployed this contract, so it can only explain it, not execute it.", next: "Pick a candidate from a verified protocol in ditto_find." },
  NOT_CONFIGURED: { reason: "This Ditto install is missing its plan-signing key, so money tools are off.", next: "Set DITTO_PLAN_KEY in the PayBox portal; read-only tools still work." },
  WAIT_PENDING: { reason: "A transaction for this plan is still pending.", next: "Wait for it to confirm, then ask for the next step. Do not send it again." },
  DUPLICATE_ENTER: { reason: "Two completed deposits match this one plan.", next: "No third deposit will be proposed. Build an exit plan for the extra position." },
  ALLOWANCE_LEFT: { reason: "A token permission from this plan is still above zero.", next: "Reset it with the revoke plan from ditto_positions." },
  SIGNER_MISMATCH: { reason: "A transaction for this plan was signed by a different wallet.", next: "Select the plan's wallet in PayBox and continue from ditto_step." },
  NOT_BOUND: { reason: "The approval or wallet-binding step for this plan is not confirmed yet.", next: "Finish the earlier step first; ditto_step proposes it." },
};
export const familyWords: Record<Plan["family"], string> = { "aave-v3": "Aave v3", erc4626: "the savings vault", "compound-v3": "Compound v3", moonwell: "Moonwell", lst: "Lido", "lp-v3": "the liquidity pool" };
export const chainWords: Record<Chain, string> = { base: "Base", arbitrum: "Arbitrum", optimism: "Optimism", ethereum: "Ethereum" };
export function symbolOf(chain: Chain, token: string) {
  if (token === "native") return "ETH";
  if (chain !== "ethereum" && same(token, usdcAddress(chain))) return "USDC";
  return `token ${token.slice(0, 6)}…${token.slice(-4)}`;
}
export const short = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;
export function describeStep(p: Plan, step: Step, index: number, total: number, gasUsd?: string) {
  const amount = `${p.amount.display} ${symbolOf(p.chain, p.asset)}`, where = `${familyWords[p.family]} (${short(p.contract)}) on ${chainWords[p.chain]}`;
  const token = symbolOf(p.chain, step.to);
  const what = step.kind === "bind" ? "send a 0-value transaction from your wallet to itself. It proves this is the wallet signing the plan; nothing moves."
    : step.kind === "approve" ? `allow ${short(String(step.args[0]))} to take exactly ${step.args[1] === p.amount.atomic ? amount : `${step.args[1]} units of ${token}`} from your wallet. Nothing moves yet.`
    : step.kind === "approve-zero" ? `reset the existing ${token} permission for ${short(String(step.args[0]))} to 0 first; this token requires it. Nothing moves.`
    : step.kind === "revoke" ? `set the ${token} permission for ${short(String(step.args[0]))} back to 0.`
    : step.kind === "swap" ? "swap part of your starting token for the pool's other token, with a 0.5% price limit."
    : step.kind === "enter" ? (p.family === "lp-v3" ? `open the liquidity position in ${where}, minted to your wallet.` : `put ${amount} into ${where}.`)
    : step.kind === "claim" ? `claim your finished withdrawal from ${where}, paid to your wallet.`
    : `take your position out of ${where}, paid to your wallet.`;
  return `Step ${index + 1} of ${total}: ${what}${gasUsd ? ` Gas ≈ $${gasUsd}.` : ""}`;
}
export function planSummary(p: Plan, exitDetail: string) {
  const kinds = p.steps.map(s => s.kind).join(", ");
  const head = p.execution?.mode === "exit" ? `Plan: take your position out of ${familyWords[p.family]} (${short(p.contract)}) on ${chainWords[p.chain]}, paid to ${p.wallet}.`
    : p.execution?.mode === "revoke" ? `Plan: reset a leftover permission on ${chainWords[p.chain]}. No money moves.`
    : `Plan: put ${p.amount.display} ${symbolOf(p.chain, p.asset)} into ${familyWords[p.family]} (${short(p.contract)}) on ${chainWords[p.chain]} for wallet ${p.wallet}. You get at least ${p.minReceive.display} of the receipt token.`;
  return `${head} ${exitDetail} Expected PayBox approvals: up to ${p.steps.length} (${kinds}). Revokes are only proposed while a permission is above zero.`;
}
