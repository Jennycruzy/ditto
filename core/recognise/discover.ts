import { decodeEventLog, parseAbi, toEventSelector, type Address, type Hex } from "viem";
import provenance from "../provenance.json" with { type: "json" };
import { events } from "../abis.js";
import { recipes, recipe, positionFragment } from "../recipes/index.js";
import { addr, read, same } from "../recipes/shared.js";
import type { Family, IdentifyOptions, Identity, RecogniseContext } from "../recipes/types.js";
import type { Rpc } from "../rpc.js";
import type { Chain } from "../chains.js";
import { morphoListing } from "../morpho.js";
import { receiptSchema } from "./schemas.js";

export type DiscoveryOptions = { maxContracts?: number; listing?: (address: Address, chain: Chain) => Promise<IdentifyOptions["listing"] & { warnings?: string[] } | undefined> };
export async function discoverReceipt(chain: Chain, raw: unknown, rpc: Rpc, options: DiscoveryOptions = {}) {
  const receipt = receiptSchema.parse(raw), identities: Identity[] = [], lpPositions: NonNullable<RecogniseContext["lpPositions"]> = {}, failures: string[] = [];
  let incomplete = false;
  if (receipt.status !== "0x1") return { context: { chain, identities, lpPositions }, incomplete, failures };
  const candidates = new Map<string, { family: Family; contract: Address; asset?: Address }>();
  const add = (family: Family, contract: Address, asset?: Address) => candidates.set(`${family}:${contract.toLowerCase()}:${asset ?? ""}`, { family, contract, ...(asset ? { asset } : {}) });
  const topic = (event: string) => toEventSelector(event).toLowerCase();
  const vaultTopics = [topic(events.deposit), topic(events.withdraw)];
  for (const log of receipt.logs) {
    if (log.removed) continue;
    const t = log.topics[0]?.toLowerCase();
    if (vaultTopics.includes(t ?? "")) add("erc4626", log.address);
    if (chain !== "ethereum") {
      if (same(log.address, provenance.aave[chain].pool) && [events.aaveSupply, events.aaveWithdraw, events.aaveBorrow, events.aaveRepay].some(e => topic(e) === t)) {
        const reserve = log.topics[1]; if (reserve && /^0x0{24}[0-9a-fA-F]{40}$/.test(reserve)) add("aave-v3", log.address, addr(`0x${reserve.slice(-40)}`));
      }
      if (same(log.address, provenance.compound[chain].comet)) add("compound-v3", log.address);
      if ((chain === "base" || chain === "optimism") && same(log.address, provenance.moonwell[chain].market)) add("moonwell", log.address);
    }
    if (chain === "ethereum") {
      if (same(log.address, provenance.lido.steth)) add("lst", addr(provenance.lido.steth));
      if (same(log.address, provenance.lido.wsteth)) add("lst", addr(provenance.lido.wsteth));
    }
  }
  const cap = Math.min(8, options.maxContracts ?? 4);
  if (candidates.size > cap) incomplete = true;
  await Promise.all([...candidates.values()].slice(0, cap).map(async c => {
    try {
      let listing;
      if (c.family === "erc4626") {
        try { listing = await (options.listing ?? morphoListing)(c.contract, chain); }
        catch { failures.push(`Morpho listing and warnings are unavailable for ${c.contract}; no empty warning list is claimed.`); }
      }
      const identity = await recipe(c.family).identify(c.contract, chain, rpc, { block: receipt.blockNumber as Hex, wallet: receipt.from, ...(c.asset ? { asset: c.asset } : {}), ...(listing ? { listing } : {}) });
      if (identity) {
        if (c.family === "erc4626") { identity.details.warningStatus = listing ? "observed" : "unavailable"; identity.details.pauseStatus = "ERC-4626 has no standard pause getter; deposit and exit must be simulated."; }
        if (listing?.warnings) identity.details.warnings = listing.warnings;
        identities.push(identity);
      }
    } catch { incomplete = true; failures.push(`Could not identify ${c.contract} from block ${BigInt(receipt.blockNumber)}.`); }
  }));
  if (chain === "base") {
    for (const registry of Object.values(provenance.lp)) {
      const logs = receipt.logs.filter(l => !l.removed && same(l.address, registry.npm) && [topic(events.increase), topic(events.collect)].includes(l.topics[0]?.toLowerCase() ?? ""));
      const ids = [...new Set(logs.map(l => l.topics[1]).filter((id): id is string => !!id))];
      if (ids.length > cap) incomplete = true;
      for (const id of ids.slice(0, cap)) {
        try {
          const uniswap = same(registry.npm, provenance.lp.uniswap.npm), npm = addr(registry.npm);
          const p = await read(rpc, npm, positionFragment(uniswap), [BigInt(id)], receipt.blockNumber as Hex) as readonly unknown[];
          const pool = await read(rpc, addr(registry.factory), `function getPool(address,address,${uniswap ? "uint24" : "int24"}) view returns (address)`, [p[2], p[3], p[4]], receipt.blockNumber as Hex) as Address;
          let identity = identities.find(i => i.family === "lp-v3" && same(i.contract, pool));
          if (!identity) { identity = await recipes["lp-v3"]!.identify(pool, chain, rpc, { block: receipt.blockNumber as Hex }) ?? undefined; if (identity) identities.push(identity); }
          if (!identity) continue;
          lpPositions[`${npm.toLowerCase()}:${BigInt(id)}`] = { pool: identity.contract, token0: p[2] as Address, token1: p[3] as Address, tickLower: Number(p[5]), tickUpper: Number(p[6]) };
        } catch { incomplete = true; failures.push(`Position ${BigInt(id)} could not be resolved at its receipt block; no range width was guessed.`); }
      }
    }
  }
  identities.sort((a, b) => `${a.family}:${a.contract}:${a.asset}`.localeCompare(`${b.family}:${b.contract}:${b.asset}`));
  return { context: { chain, identities, lpPositions }, incomplete, failures: failures.sort() };
}
