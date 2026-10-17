import { decodeEventLog, parseAbi, toHex, type Address, type Hex } from "viem";
import provenance from "../provenance.json" with { type: "json" };
import { events, fragments } from "../abis.js";
import { usdcAddress } from "../chains.js";
import { encodeStep, makeStep } from "../encoding.js";
import { parseTokenTransfers, simulate } from "../simulate.js";
import { addr, approvals, f, MAX, minAfterSlip, positive, read, reads, requireIdentity, same, value, ZERO } from "./shared.js";
import { amountsForLiquidity, centredRange, liquidityAmounts, spotOut } from "./lp-math.js";
import type { BuildOptions, Identity, Recipe, Recognised } from "./types.js";
import type { Rpc } from "../rpc.js";

const WETH = addr("0x4200000000000000000000000000000000000006");
const uni = (i: Identity) => i.details.protocol === "uniswap";
const getNpm = (i: Identity) => addr(String(i.details.npm));
export const positionFragment = (uniswap: boolean) => `function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,${uniswap ? "uint24 fee" : "int24 tickSpacing"},int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)`;
export const lpV3: Recipe = {
  family: "lp-v3", chains: ["base"],
  async identify(contract, chain, rpc, options = {}) {
    if (chain !== "base") return null;
    const block = options.block ?? "latest";
    const [factory, token0, token1, spacing, fee, liquidity] = await reads(rpc, [
      { to: contract, fragment: "function factory() view returns (address)" }, { to: contract, fragment: "function token0() view returns (address)" }, { to: contract, fragment: "function token1() view returns (address)" },
      { to: contract, fragment: "function tickSpacing() view returns (int24)" }, { to: contract, fragment: "function fee() view returns (uint24)" }, { to: contract, fragment: "function liquidity() view returns (uint128)" },
    ], block) as [Address, Address, Address, number, number, bigint];
    const protocol = same(factory, provenance.lp.uniswap.factory) ? "uniswap" : same(factory, provenance.lp.aerodrome.factory) ? "aerodrome" : null;
    if (!protocol || ![token0, token1].some(t => same(t, usdcAddress("base"))) || ![token0, token1].some(t => same(t, WETH))) return null;
    const registry = provenance.lp[protocol], uniswap = protocol === "uniswap";
    const [npmFactory, routerFactory, pool, slot, d0, d1, balance0, balance1] = await reads(rpc, [
      { to: addr(registry.npm), fragment: "function factory() view returns (address)" }, { to: addr(registry.router), fragment: "function factory() view returns (address)" },
      { to: factory, fragment: `function getPool(address,address,${uniswap ? "uint24" : "int24"}) view returns (address)`, args: [token0, token1, uniswap ? fee : spacing] },
      { to: contract, fragment: `function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,${uniswap ? "uint8 feeProtocol," : ""}bool unlocked)` },
      { to: token0, fragment: f.decimals }, { to: token1, fragment: f.decimals }, { to: token0, fragment: f.balance, args: [contract] }, { to: token1, fragment: f.balance, args: [contract] },
    ], block) as [Address, Address, Address, readonly unknown[], number, number, bigint, bigint];
    if (!same(npmFactory, factory) || !same(routerFactory, factory) || !same(pool, contract)) return null;
    const price = slot[0] as bigint;
    if (price === 0n || liquidity === 0n) return null;
    const usdc0 = same(token0, usdcAddress("base"));
    const totalValue = usdc0 ? balance0 + spotOut(balance1, price, false) : balance1 + spotOut(balance0, price, true);
    return { family: "lp-v3", chain, contract, asset: usdcAddress("base"), receiptToken: addr(registry.npm), assetDecimals: 6, receiptDecimals: 0, totalAssets: totalValue.toString(), paused: slot.at(-1) !== true, cap: MAX,
      provenance: { verified: true, source: registry.source, registry: factory }, details: { protocol, npm: registry.npm, router: registry.router, quoter: registry.quoter, token0, token1, decimals0: Number(d0), decimals1: Number(d1), fee: Number(fee), spacing: Number(spacing), tick: Number(slot[1]), sqrtPriceX96: price.toString(), liquidity: liquidity.toString() } };
  },
  buildEnter(i, wallet, amount, options = {}) {
    requireIdentity(i, "lp-v3"); positive(amount);
    if (options.acceptExit !== "market") throw new Error("EXIT_NOT_ACCEPTED");
    if (!options.amount0 || !options.amount1 || !options.halfWidthTicks) throw new Error("Read a current swap quote and copied range width first");
    const token0 = addr(String(i.details.token0)), token1 = addr(String(i.details.token1)), npm = getNpm(i);
    const range = centredRange(Number(i.details.tick), options.halfWidthTicks, Number(i.details.spacing));
    const { amount0, amount1 } = liquidityAmounts(BigInt(String(i.details.sqrtPriceX96)), range.lower, range.upper, positive(options.amount0), positive(options.amount1));
    if (amount0 === 0n || amount1 === 0n) throw new Error("SIM_FAILED");
    const args = { token0, token1, ...(uni(i) ? { fee: Number(i.details.fee) } : { tickSpacing: Number(i.details.spacing) }), tickLower: range.lower, tickUpper: range.upper, amount0Desired: amount0.toString(), amount1Desired: amount1.toString(), amount0Min: minAfterSlip(amount0, Math.min(options.slippageBps ?? 50, 50)).toString(), amount1Min: minAfterSlip(amount1, Math.min(options.slippageBps ?? 50, 50)).toString(), recipient: wallet, deadline: Math.floor((options.now ?? Date.now()) / 1000) + 600, ...(!uni(i) ? { sqrtPriceX96: "0" } : {}) };
    return [...approvals(token0, npm, amount0.toString()), ...approvals(token1, npm, amount1.toString()), makeStep("enter", npm, uni(i) ? fragments.uniMint : fragments.aeroMint, [args]),
      makeStep("revoke", token0, fragments.approve, [npm, "0"]), makeStep("revoke", token1, fragments.approve, [npm, "0"])];
  },
  buildExit(i, wallet, _amount, options = {}) {
    requireIdentity({ ...i, paused: false }, "lp-v3");
    if (!options.tokenId || !options.liquidity || options.min0 === undefined || options.min1 === undefined) throw new Error("Read and simulate this position before building its exit");
    const npm = getNpm(i), deadline = Math.floor((options.now ?? Date.now()) / 1000) + 600;
    const decrease = options.liquidity === "0" ? null : makeStep("exit", npm, fragments.decrease, [{ tokenId: positive(options.tokenId).toString(), liquidity: positive(options.liquidity).toString(), amount0Min: options.min0, amount1Min: options.min1, deadline }]);
    const collect = makeStep("exit", npm, fragments.collect, [{ tokenId: options.tokenId, recipient: wallet, amount0Max: (2n ** 128n - 1n).toString(), amount1Max: (2n ** 128n - 1n).toString() }]);
    return [makeStep("exit", npm, fragments.multicall, [[...(decrease ? [encodeStep(decrease).data] : []), encodeStep(collect).data]])];
  },
  expect(i, wallet) { return [{ kind: "owner", token: getNpm(i), account: wallet, minimum: value("1", 0) }, { kind: "position", token: getNpm(i), account: wallet, minimum: value("1", 0) }, ...[i.details.token0, i.details.token1].map(t => ({ kind: "allowance" as const, token: addr(String(t)), spender: getNpm(i), account: wallet, amount: value("0", 0) }))]; },
  recognise(receipt, ctx) {
    if (receipt.status !== "0x1") return [];
    const out: Recognised[] = [], transfers = parseTokenTransfers(receipt.logs);
    for (const log of receipt.logs) {
      const i = ctx.identities.find(id => id.family === "lp-v3" && id.chain === ctx.chain && same(id.receiptToken, log.address));
      if (!i || log.removed) continue;
      for (const [event, kind] of [[events.increase, "enter"], [events.collect, "exit"]] as const) {
        try {
          const decoded = decodeEventLog({ abi: parseAbi([event] as readonly string[]), data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
          const a = decoded.args as unknown as Record<string, bigint | string>, id = String(a.tokenId);
          const position = ctx.lpPositions?.[`${log.address.toLowerCase()}:${id}`];
          if (!position || !same(position.pool, i.contract)) continue;
          const mint = transfers.find(t => t.kind === "erc721" && same(t.token, log.address) && t.tokenId === id && same(t.from, ZERO));
          if (kind === "enter" && !mint) continue;
          if (kind === "exit" && !receipt.logs.some(other => {
            if (!same(other.address, log.address)) return false;
            try { const decrease = decodeEventLog({ abi: parseAbi([events.decrease]), topics: other.topics as [Hex, ...Hex[]], data: other.data as Hex }); return decrease.args.tokenId.toString() === id; } catch { return false; }
          })) continue;
          const actor = kind === "enter" ? mint!.to : addr(String(a.recipient));
          const amount = same(position.token0, i.asset) ? String(a.amount0) : String(a.amount1);
          out.push({ kind, family: "lp-v3", contract: i.contract, asset: i.asset, amount, actor, txHash: receipt.transactionHash, tokenId: id });
        } catch { /* Only complete position-manager events are recognised. */ }
      }
    }
    return out;
  },
  async position(i, wallet, rpc) {
    const id = String(i.details.tokenId ?? "");
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Read the wallet's position NFT IDs first");
    const block = await rpc.call<Hex>("eth_blockNumber", []);
    const [owner, p, slot] = await reads(rpc, [{ to: getNpm(i), fragment: "function ownerOf(uint256) view returns (address)", args: [id] }, { to: getNpm(i), fragment: positionFragment(uni(i)), args: [id] }, { to: i.contract, fragment: `function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,${uni(i) ? "uint8 feeProtocol," : ""}bool unlocked)` }], block) as [Address, readonly unknown[], readonly unknown[]];
    if (!same(owner, wallet)) throw new Error("SIGNER_MISMATCH");
    const liquidity = p[7] as bigint;
    if (!same(p[2] as Address, String(i.details.token0)) || !same(p[3] as Address, String(i.details.token1)) || Number(p[4]) !== Number(uni(i) ? i.details.fee : i.details.spacing)) throw new Error("ASSET_MISMATCH");
    const price = slot[0] as bigint, amounts = amountsForLiquidity(price, Number(p[5]), Number(p[6]), liquidity);
    const steps = lpV3.buildExit(i, wallet, "all", { tokenId: id, liquidity: liquidity.toString(), min0: minAfterSlip(amounts.amount0, 50).toString(), min1: minAfterSlip(amounts.amount1, 50).toString() });
    const sim = await simulate(rpc, steps.map(s => ({ ...encodeStep(s), from: wallet, value: toHex(BigInt(s.value)) })), { block });
    const totals = [p[2] as Address, p[3] as Address].map(token => sim.calls.flatMap(c => c.transfers).filter(t => same(t.token, token) && same(t.to, wallet)).reduce((sum, t) => sum + BigInt(t.amount), 0n));
    const usdc0 = same(p[2] as Address, i.asset), totalValue = usdc0 ? totals[0]! + spotOut(totals[1]!, price, false) : totals[1]! + spotOut(totals[0]!, price, true);
    return { family: "lp-v3", chain: i.chain, contract: i.contract, wallet, receiptToken: getNpm(i), amountIn: null, balance: value("1", 0), valueNow: value(totalValue, 6), change: null, tokenId: id, liquidity: value(liquidity, 0), owedFees: [{ token: p[2] as Address, amount: value(p[10] as bigint, Number(i.details.decimals0)) }, { token: p[3] as Address, amount: value(p[11] as bigint, Number(i.details.decimals1)) }], exitCandidateId: `${i.chain}:lp-v3:${i.contract}:${id}`, exitPreview: { simulated: true, block: sim.block, exitClass: "market", returns: [{ token: p[2] as Address, amount: value(totals[0]!, Number(i.details.decimals0)) }, { token: p[3] as Address, amount: value(totals[1]!, Number(i.details.decimals1)) }], pass: true, detail: "Exit simulated now. It returns a mix of both tokens at the current price; that mix and value can change." } };
  },
};

export async function prepareLpSwap(i: Identity, wallet: Address, tokenIn: Address, amount: string, rpc: Rpc, options: BuildOptions & { block?: Hex | "latest" }) {
  requireIdentity(i, "lp-v3");
  if (options.acceptExit !== "market") throw new Error("EXIT_NOT_ACCEPTED");
  const input = positive(amount);
  if (![String(i.details.token0), String(i.details.token1)].some(t => same(t, tokenIn))) throw new Error("ASSET_MISMATCH");
  const tokenOut = same(tokenIn, String(i.details.token0)) ? addr(String(i.details.token1)) : addr(String(i.details.token0));
  const params = { tokenIn, tokenOut, amountIn: input.toString(), ...(uni(i) ? { fee: i.details.fee } : { tickSpacing: i.details.spacing }), sqrtPriceLimitX96: "0" };
  const result = await read(rpc, addr(String(i.details.quoter)), `function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,${uni(i) ? "uint24 fee" : "int24 tickSpacing"},uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)`, [params], options.block) as readonly bigint[];
  const output = result[0]!, priceAfter = result[1]!, spot = spotOut(input, BigInt(String(i.details.sqrtPriceX96)), same(tokenIn, String(i.details.token0)));
  if (output <= 0n || output * 10000n < spot * 9950n) throw new Error("SIM_FAILED: swap price impact exceeds 0.5%");
  const swapArgs = { tokenIn, tokenOut, ...(uni(i) ? { fee: Number(i.details.fee) } : { tickSpacing: Number(i.details.spacing), deadline: Math.floor((options.now ?? Date.now()) / 1000) + 600 }), recipient: wallet, amountIn: input.toString(), amountOutMinimum: minAfterSlip(output, 50).toString(), sqrtPriceLimitX96: "0" };
  const router = addr(String(i.details.router));
  const prefix = [...approvals(tokenIn, router, input.toString(), options), makeStep("swap", router, uni(i) ? fragments.uniSwap : fragments.aeroSwap, [swapArgs])];
  return { steps: prefix, quote: { amountIn: input.toString(), amountOut: output.toString(), spotOut: spot.toString(), priceAfter: priceAfter.toString() } };
}
export async function prepareLpEntry(i: Identity, wallet: Address, amount: string, rpc: Rpc, options: BuildOptions & { block?: Hex | "latest" }) {
  const half = positive(amount) / 2n, tokenIn = i.asset as Address;
  const swap = await prepareLpSwap(i, wallet, tokenIn, half.toString(), rpc, options);
  const output = BigInt(swap.quote.amountOut);
  const is0 = same(tokenIn, String(i.details.token0));
  const prepared = { ...options, amount0: is0 ? (BigInt(amount) - half).toString() : output.toString(), amount1: is0 ? output.toString() : (BigInt(amount) - half).toString() };
  return { steps: [...swap.steps, ...lpV3.buildEnter({ ...i, details: { ...i.details, sqrtPriceX96: swap.quote.priceAfter } }, wallet, amount, prepared)], quote: swap.quote };
}
