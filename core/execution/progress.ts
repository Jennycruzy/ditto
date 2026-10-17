import { decodeEventLog, parseAbi, type Address, type Hex } from "viem";
import { encodeStep } from "../encoding.js";
import { recipes } from "../recipes/index.js";
import { parseTokenTransfers } from "../simulate.js";
import type { Plan, Step } from "../schemas.js";
import type { Identity } from "../recipes/types.js";
import type { Rpc } from "../rpc.js";
import { same, ZERO } from "../recipes/shared.js";
import { transactionSchema, receiptSchema } from "../recognise/schemas.js";
import { refusal, type Progress, type Executed, type Transaction } from "./types.js";
const approvalEvent = parseAbi(["event Approval(address indexed owner,address indexed spender,uint256 value)"]);
function effect(step: Step, tx: Transaction, receipt: Executed["receipt"], p: Plan, i: Identity) {
  if (step.kind === "bind") return same(tx.from, p.wallet) && same(tx.to!, p.wallet) && tx.value === "0x0";
  if (["approve", "approve-zero", "revoke"].includes(step.kind)) return receipt.logs.some(l => {
    try { const a = decodeEventLog({ abi: approvalEvent, topics: l.topics as [Hex, ...Hex[]], data: l.data as Hex }).args; return same(l.address, step.to) && same(a.owner, p.wallet) && same(a.spender, String(step.args[0])) && a.value.toString() === step.args[1]; } catch { return false; }
  });
  const transfers = parseTokenTransfers(receipt.logs);
  if (step.kind === "enter") {
    if (i.family === "lp-v3") return transfers.some(t => t.kind === "erc721" && same(t.token, i.receiptToken) && same(t.from, ZERO) && same(t.to, p.wallet));
    const actions = recipes[p.family]!.recognise(receipt, { chain: p.chain, identities: [i] });
    const ownEvent = actions.some(a => a.kind === "enter" && same(a.actor, p.wallet) && a.amount === p.amount.atomic);
    const out = i.asset === "native" ? BigInt(tx.value) : transfers.filter(t => same(t.token, i.asset) && same(t.from, p.wallet)).reduce((s, t) => s + BigInt(t.amount), 0n);
    return ownEvent && out === BigInt(p.amount.atomic);
  }
  // Exact signed exit/swap calldata is checked before this function; proof checks
  // all actual movements and recipient amounts independently.
  return true;
}
export async function reconcile(plan: Plan, hashes: readonly Hex[], identity: Identity, rpc: Rpc, options: { recover?: boolean; maxPages?: number } = {}): Promise<Progress> {
  const result: Progress = { matches: [], completed: [], pending: [], duplicateEnters: [], refusals: [], incomplete: false };
  const candidates = new Set(hashes.map(h => h.toLowerCase() as Hex));
  if (options.recover !== false) {
    let pageKey: string | undefined; const seen = new Set<string>();
    for (let page = 0; page < (options.maxPages ?? 8); page++) {
      try {
        const data = await rpc.call<{ transfers: { hash: Hex }[]; pageKey?: string }>("alchemy_getAssetTransfers", [{ fromBlock: `0x${(BigInt(plan.createdAtBlock) + 1n).toString(16)}`, toBlock: "latest", fromAddress: plan.wallet, category: ["external", "erc20", "erc721", ...(plan.chain === "ethereum" ? ["internal"] : [])], excludeZeroValue: false, maxCount: "0x64", order: "asc", ...(pageKey ? { pageKey } : {}) }]);
        if (!Array.isArray(data.transfers) || data.transfers.length > 100) throw new Error("Invalid history");
        data.transfers.forEach(t => { if (!/^0x[0-9a-fA-F]{64}$/.test(t.hash)) throw new Error("Invalid hash"); candidates.add(t.hash.toLowerCase() as Hex); });
        if (!data.pageKey) break;
        if (seen.has(data.pageKey) || page === (options.maxPages ?? 8) - 1) { result.incomplete = true; break; }
        seen.add(data.pageKey); pageKey = data.pageKey;
      } catch { result.incomplete = true; break; }
    }
    // Approvals do not move tokens. Their wallet/spender-indexed logs provide a
    // second recovery path when an asset-transfer index omits zero-value calls.
    try {
      const topic = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
      const tokens = [...new Set(plan.steps.filter(s => ["approve", "approve-zero", "revoke"].includes(s.kind)).map(s => s.to))];
      if (tokens.length) {
        const logs = await rpc.call<{ transactionHash: Hex }[]>("eth_getLogs", [{ address: tokens, fromBlock: `0x${(BigInt(plan.createdAtBlock) + 1n).toString(16)}`, toBlock: "latest", topics: ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", topic(plan.wallet)] }]);
        logs.forEach(l => candidates.add(l.transactionHash));
      }
    } catch { if (!hashes.length) result.incomplete = true; }
  }
  if (candidates.size > 100) { result.incomplete = true; }
  const confirmed: { hash: Hex; tx: Transaction; receipt: Executed["receipt"]; indices: { step: Step; index: number }[] }[] = [];
  for (const hash of [...candidates].slice(0, 100)) {
    let tx: Transaction, receipt: Executed["receipt"] | null;
    try {
      const [rawTx, rawReceipt] = await rpc.batch([{ method: "eth_getTransactionByHash", params: [hash] }, { method: "eth_getTransactionReceipt", params: [hash] }]);
      if (!rawTx) { if (hashes.some(h => same(h, hash))) result.refusals.push(refusal("RPC_UNAVAILABLE", "A supplied transaction could not be found.")); continue; }
      tx = transactionSchema.parse(rawTx) as Transaction;
      if (!same(tx.hash, hash)) throw new Error("Wrong transaction");
      receipt = rawReceipt ? { ...(rawReceipt as Executed["receipt"]), ...receiptSchema.parse(rawReceipt) } as Executed["receipt"] : null;
      if (receipt && (!same(receipt.transactionHash, hash) || receipt.blockNumber !== tx.blockNumber || !same((rawReceipt as { blockHash: string }).blockHash, tx.blockHash ?? "") || !same(receipt.from, tx.from))) throw new Error("Mismatched receipt");
    } catch { result.incomplete = true; continue; }
    const indices = plan.steps.map((step, index) => ({ step, index })).filter(({ step }) => { const encoded = encodeStep(step); return tx.to && same(tx.to, encoded.to) && same(tx.input, encoded.data) && BigInt(tx.value) === BigInt(encoded.value); });
    if (!same(tx.from, plan.wallet)) {
      if (hashes.some(h => same(h, hash))) result.refusals.push(refusal("SIGNER_MISMATCH", `Transaction ${hash} was signed by another wallet.`));
      continue;
    }
    if (!indices.length) { if (hashes.some(h => same(h, hash))) result.refusals.push(refusal("PLAN_TAMPERED", "A supplied transaction does not match this plan's exact calldata.")); continue; }
    if (!receipt) { result.pending.push(hash); continue; }
    if (receipt.status !== "0x1" || BigInt(receipt.blockNumber) <= BigInt(plan.createdAtBlock)) continue;
    confirmed.push({ hash, tx, receipt, indices });
  }
  confirmed.sort((a, b) => BigInt(a.receipt.blockNumber) === BigInt(b.receipt.blockNumber) ? Number(BigInt((a.receipt as unknown as { transactionIndex?: Hex }).transactionIndex ?? "0x0") - BigInt((b.receipt as unknown as { transactionIndex?: Hex }).transactionIndex ?? "0x0")) : BigInt(a.receipt.blockNumber) < BigInt(b.receipt.blockNumber) ? -1 : 1);
  for (const { hash, tx, receipt, indices } of confirmed) {
    const eligible = indices.find(({ index, step }) => plan.steps.slice(0, index).every((previous, n) => previous.kind === "revoke" || result.completed.includes(n)) && effect(step, tx, receipt, plan, identity));
    if (eligible) { result.matches.push({ hash, tx, receipt, index: eligible.index }); if (!result.completed.includes(eligible.index)) result.completed.push(eligible.index); }
    else result.refusals.push(refusal("NOT_BOUND", "A matching transaction ran before this plan's required binding or approval steps, or its event effect did not match."));
  }
  const enters = [...new Set(result.matches.filter(m => plan.steps[m.index]!.kind === "enter").map(m => m.hash))];
  if (enters.length > 1) { result.duplicateEnters = enters; result.refusals.push(refusal("DUPLICATE_ENTER", "Two completed entries match this plan. No third entry will be proposed; build an exit for the extra position.")); }
  if (result.pending.length) result.refusals.push(refusal("WAIT_PENDING", "A matching transaction is still pending. Wait for its receipt; do not request it again."));
  if (result.incomplete) result.refusals.push(refusal("RPC_UNAVAILABLE", "Progress recovery is incomplete. Supply all plan transaction hashes or retry; no proposal is safe yet."));
  result.completed.sort((a, b) => a - b); return result;
}
