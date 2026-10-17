import * as z from "zod/v4";
import { type Address, type Hex } from "viem";
import { addressSchema, chainSchema } from "../schemas.js";
import { recipes, positionFragment, type Identity, type Family } from "../recipes/index.js";
import provenance from "../provenance.json" with { type: "json" };
import { read, f, addr, same } from "../recipes/shared.js";
import { readPositions } from "./positions.js";
import { ExecutionEngine } from "./engine.js";
import type { Config, Target } from "./types.js";
import type { Rpc } from "../rpc.js";
export async function positionsTool(input: unknown, dependencies: { config: Config; rpc: (chain: Target["chain"]) => Rpc; targets?: (chain: Target["chain"]) => Promise<Target[]> }) {
  const args = z.object({ wallet: addressSchema, chains: z.array(chainSchema).min(1).max(4).default(["base", "arbitrum", "optimism", "ethereum"]) }).strict().parse(input);
  const identities: Identity[] = [], failures: string[] = [];
  for (const chain of [...new Set(args.chains)]) {
    const rpc = dependencies.rpc(chain), engine = new ExecutionEngine(rpc, dependencies.config), block = await rpc.call<Hex>("eth_blockNumber", []);
    const targets: Target[] = [];
    const add = (family: Family, contract: string) => { if (!targets.some(t => t.family === family && same(t.contract, contract))) targets.push({ family, chain, contract: addr(contract) }); };
    if (chain !== "ethereum") { add("aave-v3", provenance.aave[chain].pool); add("compound-v3", provenance.compound[chain].comet); }
    if (chain === "base" || chain === "optimism") add("moonwell", provenance.moonwell[chain].market);
    if (chain === "ethereum") { add("lst", provenance.lido.steth); add("lst", provenance.lido.wsteth); }
    for (const v of provenance.namedVaults.filter(v => v.chain === chain)) add("erc4626", v.address);
    if (dependencies.targets) { try { for (const t of await dependencies.targets(chain)) if (t.chain === chain) add(t.family, t.contract); } catch { failures.push(`${chain}: candidate index unavailable; chain discovery used instead.`); } }
    const nftIds: { npm: Address; id: string }[] = [];
    let pageKey: string | undefined;
    for (let n = 0; n < 4; n++) {
      try {
        const page = await rpc.call<{ transfers: { rawContract: { address: string }; erc721TokenId?: Hex; category: string }[]; pageKey?: string }>("alchemy_getAssetTransfers", [{ fromBlock: "0x0", toBlock: block, toAddress: args.wallet, category: ["erc20", "erc721"], order: "desc", maxCount: "0x64", excludeZeroValue: true, ...(pageKey ? { pageKey } : {}) }]);
        for (const t of page.transfers) {
          if (!/^0x[0-9a-fA-F]{40}$/.test(t.rawContract.address)) continue;
          const npm = Object.values(provenance.lp).find(p => same(p.npm, t.rawContract.address));
          if (chain === "base" && npm && t.erc721TokenId) nftIds.push({ npm: addr(npm.npm), id: BigInt(t.erc721TokenId).toString() });
          else if (t.category === "erc20" && targets.length < 32) add("erc4626", t.rawContract.address);
        }
        if (!page.pageKey) break; if (n === 3) failures.push(`${chain}: additional incoming-token pages remain.`); pageKey = page.pageKey;
      } catch { failures.push(`${chain}: incoming-token discovery is incomplete.`); break; }
    }
    for (const t of targets) {
      try { const identity = await engine.identity(t, args.wallet, block); if (identity.provenance.verified && !identities.some(i => i.chain === chain && i.family === identity.family && same(i.contract, identity.contract))) identities.push(identity); }
      catch { /* A transfer token that is not an identified vault is not a position candidate. */ }
    }
    for (const { npm, id } of [...new Map(nftIds.map(n => [`${n.npm}:${n.id}`, n])).values()].slice(0, 32)) {
      try {
        const owner = await read(rpc, npm, "function ownerOf(uint256) view returns (address)", [id], block) as Address;
        if (!same(owner, args.wallet)) continue;
        const uniswap = same(npm, provenance.lp.uniswap.npm), registry = uniswap ? provenance.lp.uniswap : provenance.lp.aerodrome;
        const position = await read(rpc, npm, positionFragment(uniswap), [id], block) as readonly unknown[];
        const pool = await read(rpc, addr(registry.factory), `function getPool(address,address,${uniswap ? "uint24" : "int24"}) view returns (address)`, [position[2], position[3], position[4]], block) as Address;
        const identity = await engine.identity({ chain, family: "lp-v3", contract: pool }, args.wallet, block); identity.details.tokenId = id; identities.push(identity);
      } catch { /* Burned or transferred NFTs have no position owned by this wallet. */ }
    }
  }
  const result = await readPositions(args.wallet, identities, dependencies.rpc);
  return { ...result, incomplete: result.incomplete || failures.length > 0, failures: [...result.failures, ...failures] };
}
