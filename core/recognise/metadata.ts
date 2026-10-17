import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { Rpc } from "../rpc.js";
import type { RecogniseContext } from "../recipes/types.js";
import { addr } from "../recipes/shared.js";
// Names and symbols are untrusted contract data. Read failures never invent them.
export async function readDisplayMetadata(context: RecogniseContext, rpc: Rpc, block: Hex) {
  const targets = new Map<string, { address: Address; name: boolean; decimals: boolean }>();
  const add = (address: Address, name = false) => {
    const key = address.toLowerCase(), old = targets.get(key);
    targets.set(key, { address, name: name || old?.name || false, decimals: true });
  };
  for (const i of context.identities) {
    if (!["aave-v3", "lp-v3"].includes(i.family)) add(i.contract, true);
    if (i.family !== "lp-v3") add(i.receiptToken);
    if (i.asset !== "native") add(i.asset);
    for (const key of ["token0", "token1"]) if (typeof i.details[key] === "string") add(addr(i.details[key] as string));
  }
  const entries = [...targets.values()].slice(0, 20).flatMap(t => ["symbol", "decimals", ...(t.name ? ["name"] : [])].map(field => ({ address: t.address, field: field as "symbol" | "name" | "decimals" })));
  const fields = { symbol: "function symbol() view returns (string)", name: "function name() view returns (string)", decimals: "function decimals() view returns (uint8)" } as const;
  const batch = entries.map(e => { const abi = parseAbi([fields[e.field as keyof typeof fields]]); return { method: "eth_call", params: [{ to: e.address, data: encodeFunctionData({ abi, functionName: e.field }) }, block] }; });
  const values: Record<string, { symbol?: string; name?: string; decimals?: number }> = {};
  try {
    // Public aggregate3 interface: https://www.multicall3.com/ (allowFailure per getter).
    const abi = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);
    const data = encodeFunctionData({ abi, functionName: "aggregate3", args: [batch.map(c => ({ target: (c.params[0] as { to: Address }).to, allowFailure: true, callData: (c.params[0] as { data: Hex }).data }))] });
    if (!batch.length) return;
    const raw = await rpc.call<Hex>("eth_call", [{ to: "0xcA11bde05977b3631167028862bE2a173976CA11", data }, block]);
    const results = decodeFunctionResult({ abi, functionName: "aggregate3", data: raw });
    entries.forEach((e, n) => {
      try {
        const value = decodeFunctionResult({ abi: parseAbi([fields[e.field as keyof typeof fields]]), functionName: e.field, data: results[n]?.success ? results[n]!.returnData : "0x" });
        const target = values[e.address.toLowerCase()] ??= {};
        if (e.field === "decimals") target.decimals = Number(value);
        else if (typeof value === "string") target[e.field as "symbol" | "name"] = value;
      } catch { /* Pools may omit name/symbol; token amounts can still be decoded. */ }
    });
  } catch { /* Display fields are optional and cannot change action recognition. */ }
  context.identities.forEach(i => {
    const asset = i.asset === "native" ? { symbol: "ETH", decimals: 18 } : values[i.asset.toLowerCase()];
    i.details.display = { ...(asset ? { asset } : {}), receipt: values[i.receiptToken.toLowerCase()] ?? {}, contract: values[i.contract.toLowerCase()] ?? {}, token0: typeof i.details.token0 === "string" ? values[i.details.token0.toLowerCase()] ?? {} : {}, token1: typeof i.details.token1 === "string" ? values[i.details.token1.toLowerCase()] ?? {} : {} };
  });
}
