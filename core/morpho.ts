import * as z from "zod/v4";
import { chains, type Chain } from "./chains.js";
import { addressSchema } from "./schemas.js";
import type { Address } from "viem";
const warning = z.object({ type: z.string().max(300), level: z.string().max(40) });
const vault = z.object({ address: addressSchema, listed: z.boolean(), warnings: z.array(warning).max(64), totalAssetsUsd: z.number().finite().nonnegative().nullable().optional(), state: z.object({ totalAssetsUsd: z.number().finite().nonnegative().nullable() }).nullable().optional() });
const response = z.object({ data: z.object({ v2: vault.nullable().optional(), v1: vault.nullable().optional() }).nullable().optional() });
export function morphoQuery(address: Address, chain: Chain, version: "v1" | "v2" = "v2") {
  const contract = addressSchema.parse(address);
  return version === "v2" ? `{v2:vaultV2ByAddress(address:"${contract}",chainId:${chains[chain].id}){address listed totalAssetsUsd warnings{type level}}}` : `{v1:vaultByAddress(address:"${contract}",chainId:${chains[chain].id}){address listed state{totalAssetsUsd} warnings{type level}}}`;
}
export function parseMorphoListing(body: unknown, address: Address, chain: Chain, now = Date.now()) {
  const data = response.parse(body).data, v = data?.v2 ?? data?.v1;
  if (!v) return undefined;
  if (v.address.toLowerCase() !== address.toLowerCase()) throw new Error("Wrong vault in listing response");
  return { address: v.address, chain, listed: v.listed, totalAssetsUsd: String(v.totalAssetsUsd ?? v.state?.totalAssetsUsd ?? 0), fetchedAt: new Date(now).toISOString(), warnings: v.warnings.map(w => `${w.level}: ${w.type}`) };
}
export async function morphoListing(address: Address, chain: Chain, fetcher: typeof fetch = fetch, now = Date.now()) {
  for (const version of ["v2", "v1"] as const) {
    const r = await fetcher("https://api.morpho.org/graphql", { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: morphoQuery(address, chain, version) }), signal: AbortSignal.timeout(1200) });
    if (!r.ok || Number(r.headers.get("content-length")) > 131072) throw new Error("Morpho listing unavailable");
    const text = await r.text(); if (text.length > 131072) throw new Error("Morpho listing response too large");
    const result = parseMorphoListing(JSON.parse(text), address, chain, now);
    if (result) return result;
  }
  return undefined;
}
