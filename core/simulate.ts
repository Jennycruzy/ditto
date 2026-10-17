import * as z from "zod/v4";
import { encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { addressSchema, hexSchema } from "./schemas.js";
import { NATIVE } from "./chains.js";
import type { Rpc } from "./rpc.js";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// DOCUMENTED: https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth
export const ETH_TRACE_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const word = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
export const logSchema = z.object({ address: addressSchema, topics: z.array(word).max(4), data: hexSchema, removed: z.boolean().optional() });
export type Log = z.input<typeof logSchema>;
export type TokenTransfer = { kind: "erc20" | "erc721" | "native"; token: Address | typeof NATIVE; from: Address; to: Address; amount: string; tokenId?: string };
export class SimulationError extends Error {
  constructor(readonly reason: "invalid-input" | "invalid-result" | "call-failed" | "malformed-transfer", readonly callIndex?: number) { super(`SIM_FAILED: ${reason}`); }
}
function topicAddress(topic: string): Address {
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) throw new SimulationError("malformed-transfer");
  return getAddress(`0x${topic.slice(-40)}`);
}
export function parseTokenTransfers(logs: readonly Log[], nativeTrace = false): TokenTransfer[] {
  const out: TokenTransfer[] = [];
  for (const raw of logs) {
    const parsed = logSchema.safeParse(raw);
    if (!parsed.success) throw new SimulationError("invalid-result");
    const log = parsed.data;
    if (log.removed) throw new SimulationError("invalid-result");
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = topicAddress(log.topics[1] ?? ""), to = topicAddress(log.topics[2] ?? "");
    if (log.topics.length === 3 && /^0x[0-9a-fA-F]{64}$/.test(log.data)) {
      const native = nativeTrace && log.address.toLowerCase() === ETH_TRACE_ADDRESS;
      out.push({ kind: native ? "native" : "erc20", token: native ? NATIVE : log.address, from, to, amount: BigInt(log.data).toString() });
    } else if (log.topics.length === 4 && log.data === "0x") {
      out.push({ kind: "erc721", token: log.address, from, to, amount: "1", tokenId: BigInt(log.topics[3]!).toString() });
    } else throw new SimulationError("malformed-transfer");
  }
  return out;
}
export function walletDeltas(transfers: readonly TokenTransfer[], wallet: string) {
  const deltas = new Map<string, { token: Address | typeof NATIVE; tokenId?: string; delta: bigint }>();
  for (const t of transfers) {
    const key = `${t.token.toLowerCase()}:${t.tokenId ?? ""}`;
    const entry = deltas.get(key) ?? { token: t.token, ...(t.tokenId !== undefined ? { tokenId: t.tokenId } : {}), delta: 0n };
    if (t.from.toLowerCase() === wallet.toLowerCase()) entry.delta -= BigInt(t.amount);
    if (t.to.toLowerCase() === wallet.toLowerCase()) entry.delta += BigInt(t.amount);
    deltas.set(key, entry);
  }
  return [...deltas.values()].filter(t => t.delta !== 0n).map(t => ({ ...t, delta: t.delta.toString() }));
}

const overrideAccountSchema = z.object({ balance: quantity.optional(), nonce: quantity.optional(), code: hexSchema.optional(), state: z.record(word, word).optional(), stateDiff: z.record(word, word).optional() }).strict().refine(a => !(a.state && a.stateDiff), "Use state or stateDiff, not both");
const overridesSchema = z.record(addressSchema, overrideAccountSchema);
export type StateOverrides = z.input<typeof overridesSchema>;
const callSchema = z.object({ from: addressSchema, to: addressSchema, data: hexSchema, value: quantity.optional(), gas: quantity.optional() }).strict();
export type SimulationCall = z.input<typeof callSchema>;
const resultCallSchema = z.object({ status: z.enum(["0x0", "0x1"]), returnData: hexSchema, gasUsed: quantity, logs: z.array(logSchema).max(4096).optional(), error: z.object({ code: z.number(), message: z.string(), data: hexSchema.optional() }).optional() });
const resultSchema = z.array(z.object({ number: quantity, hash: word.optional(), calls: z.array(resultCallSchema).max(64) })).length(1);
export type Simulation = {
  simulated: true; balancesOverridden: boolean; block: string;
  calls: { returnData: Hex; gasUsed: string; transfers: TokenTransfer[]; logs: Log[] }[];
};
export async function simulate(rpc: Rpc, calls: readonly SimulationCall[], options: { block?: Hex | "latest"; stateOverrides?: StateOverrides } = {}): Promise<Simulation> {
  const parsedCalls = z.array(callSchema).min(1).max(64).safeParse(calls);
  const parsedOverrides = overridesSchema.safeParse(options.stateOverrides ?? {});
  if (!parsedCalls.success || !parsedOverrides.success || (options.block !== undefined && options.block !== "latest" && !quantity.safeParse(options.block).success)) throw new SimulationError("invalid-input");
  const raw = await rpc.call<unknown>("eth_simulateV1", [{
    blockStateCalls: [{ calls: parsedCalls.data, ...(options.stateOverrides ? { stateOverrides: parsedOverrides.data } : {}) }],
    traceTransfers: true, validation: false, returnFullTransactions: false,
  }, options.block ?? "latest"]);
  const result = resultSchema.safeParse(raw);
  if (!result.success || result.data[0]!.calls.length !== calls.length) throw new SimulationError("invalid-result");
  const block = result.data[0]!;
  const parsed = block.calls.map((call, i) => {
    if (call.status !== "0x1" || call.error || !call.logs) throw new SimulationError("call-failed", i);
    return { returnData: call.returnData as Hex, gasUsed: BigInt(call.gasUsed).toString(), transfers: parseTokenTransfers(call.logs, true), logs: call.logs };
  });
  return { simulated: true, balancesOverridden: options.stateOverrides !== undefined, block: BigInt(block.number).toString(), calls: parsed };
}
export function mappingSlot(wallet: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [wallet, slot]));
}
// The caller must supply a slot verified for this token on this chain.
export function dryRunOverrides(wallet: Address, token: Address, amount: bigint, verifiedBalanceSlot: bigint): StateOverrides {
  if (wallet.toLowerCase() === token.toLowerCase() || amount < 0n || amount >= 2n ** 256n || verifiedBalanceSlot < 0n || verifiedBalanceSlot >= 2n ** 256n) throw new SimulationError("invalid-input");
  return {
    [wallet]: { balance: toHex(10n ** 16n) },
    [token]: { stateDiff: { [mappingSlot(wallet, verifiedBalanceSlot)]: toHex(amount, { size: 32 }) } },
  };
}
