import { type Address, type Hex } from "viem";
import type { Chain } from "../chains.js";
import { recipes, type Identity } from "../recipes/index.js";
import { f, call, same, value } from "../recipes/shared.js";
import type { Rpc } from "../rpc.js";
// The candidate index is internal atlas/live-discovery data, not agent-supplied
// contracts. Identity is rechecked by the caller before this bounded reader.
export async function readPositions(wallet: Address, identities: readonly Identity[], rpcForChain: (chain: Chain) => Rpc) {
  const positions: import("../schemas.js").Position[] = [], permissions: { chain: Chain; token: Address; spender: Address; amount: ReturnType<typeof value>; exitCandidateId: string }[] = [], failures: string[] = [];
  for (const chain of [...new Set(identities.map(i => i.chain))]) {
    const rpc = rpcForChain(chain), candidates = identities.filter(i => i.chain === chain), block = await rpc.call<Hex>("eth_blockNumber", []);
    const spenders = candidates.flatMap(i => [i.contract, i.details.npm, i.details.router, i.details.queue].filter((s): s is Address => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s)).map(spender => ({ i, spender })));
    const raw = await rpc.batch([...candidates.filter(i => i.family !== "lp-v3").map(i => call(i.receiptToken, f.balance, [wallet], block)), ...spenders.filter(p => p.i.asset !== "native").map(p => call(p.i.asset as Address, f.allowance, [wallet, p.spender], block))]);
    let offset = 0;
    const held = candidates.filter(i => i.family !== "lp-v3").filter(() => BigInt(raw[offset++] as string) > 0n);
    for (const p of spenders.filter(p => p.i.asset !== "native")) { const amount = BigInt(raw[offset++] as string); if (amount > 0n) permissions.push({ chain, token: p.i.asset as Address, spender: p.spender, amount: value(amount, p.i.assetDecimals), exitCandidateId: `${chain}:${p.i.family}:${p.i.contract}:revoke:${p.spender}` }); }
    const read = await Promise.all([...held, ...candidates.filter(i => i.family === "lp-v3" && i.details.tokenId)].map(i => recipes[i.family]!.position(i, wallet, rpc).catch(() => { failures.push(`Could not read or simulate ${chain}:${i.contract}.`); return null; })));
    for (const p of read) if (p) positions.push(p);
  }
  return { positions, leftoverPermissions: permissions, incomplete: failures.length > 0, failures, text: `Found ${positions.length} positions and ${permissions.length} leftover token permissions. Amount in and change remain unknown unless supplied by verified plan receipts.` };
}
