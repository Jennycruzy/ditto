import { explainInputSchema, explanationSchema, transactionSchema } from "./schemas.js";
import { decodeReceipt, transactionHash } from "./decode.js";
import { discoverReceipt, type DiscoveryOptions } from "./discover.js";
import { readDisplayMetadata } from "./metadata.js";
import type { Rpc } from "../rpc.js";
export const recognitionRpcBudgets = { explain: 32, walletMoves: 96 } as const;
export async function explainTransaction(input: unknown, rpc: Rpc, options: DiscoveryOptions & { now?: number } = {}) {
  const started = performance.now(), args = explainInputSchema.parse(input), hash = transactionHash(args.chain, args.tx);
  const [tx, receipt] = await rpc.batch([{ method: "eth_getTransactionByHash", params: [hash] }, { method: "eth_getTransactionReceipt", params: [hash] }]);
  if (!tx) throw new Error("RPC_UNAVAILABLE: transaction not found on this chain");
  if (transactionSchema.parse(tx).hash.toLowerCase() !== hash.toLowerCase()) throw new Error("RPC_UNAVAILABLE: wrong transaction returned");
  const discovered = receipt ? await discoverReceipt(args.chain, receipt, rpc, options) : { context: { chain: args.chain, identities: [] }, incomplete: false, failures: [] };
  if (receipt) await readDisplayMetadata(discovered.context, rpc, transactionSchema.parse(tx).blockNumber as `0x${string}`);
  const output = decodeReceipt(args.chain, tx, receipt, discovered.context, { now: options.now, incomplete: discovered.incomplete, ...(discovered.failures.length ? { reason: discovered.failures.join(" ").slice(0, 500) } : {}) });
  output.ditto.timingsMs.total = performance.now() - started;
  return explanationSchema.parse(output);
}
