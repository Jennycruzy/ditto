import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { decodeFunctionResult, getAddress, parseAbi } from "viem";
import { JsonRpc, recipe, parseTokenTransfers, positionFragment } from "../dist/core.mjs";

const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!key) throw new Error("Missing local credential");
const headers = { authorization: `Bearer ${key}` };
const rpc = chain => new JsonRpc(chain, { headers, maxRequests: 64 });
const source = new URL("../test/fixtures/recipes/", import.meta.url), dest = new URL("../test/fixtures/receipts/", import.meta.url);
await mkdir(dest, { recursive: true });
const selections = process.argv.slice(2).filter(a => !a.startsWith("--")), seen = new Set(); let failures = 0;
let sources = await Promise.all((await readdir(source)).filter(f => f.endsWith(".json")).map(async file => JSON.parse(await readFile(new URL(file, source), "utf8"))));
const contractArg = process.argv.find(a => a.startsWith("--contract="));
if (contractArg) {
  const chain = process.argv.find(a => a.startsWith("--chain="))?.split("=")[1] ?? "base";
  const identity = await recipe("erc4626").identify(getAddress(contractArg.split("=")[1]), chain, rpc(chain));
  if (!identity) throw new Error("Contract not identified");
  sources = [{ name: `vault-${chain}-additional`, identity }];
}
const toBlock = process.argv.find(a => a.startsWith("--to-block="))?.split("=")[1] ?? "latest";
const order = process.argv.includes("--oldest") ? "asc" : "desc";
for (const fixture of sources) {
  const i = fixture.identity;
  if (!i || (selections.length && !selections.includes(fixture.name))) continue;
  const key = `${i.family}:${i.chain}:${i.contract}`;
  if (seen.has(key)) continue; seen.add(key);
  try {
    const r = recipe(i.family), saved = new Map(), lp = i.family === "lp-v3", target = lp ? i.receiptToken : i.family === "aave-v3" ? i.receiptToken : i.contract;
    const filter = lp ? { fromAddress: "0x0000000000000000000000000000000000000000", contractAddresses: [target], category: ["erc721"] } : i.family === "lst" && !i.details.wrapped ? { toAddress: target, category: ["external", "internal"] } : fixture.name === "fluid-base" ? { contractAddresses: [i.receiptToken], category: ["erc20"] } : { toAddress: target, contractAddresses: [i.asset], category: ["erc20"] };
    const inspected = new Set(); let pageKey;
    for (let page = 0; page < 3 && saved.size < 2; page++) {
      const list = await rpc(i.chain).call("alchemy_getAssetTransfers", [{ fromBlock: "0x0", toBlock, ...filter, maxCount: "0x80", order, ...(pageKey ? { pageKey } : {}) }]);
      for (const t of list.transfers) {
        if (inspected.has(t.hash)) continue; inspected.add(t.hash);
        const tx = await rpc(i.chain).call("eth_getTransactionByHash", [t.hash]);
        if (!tx) continue;
        const route = tx.to?.toLowerCase() === (lp ? i.receiptToken : i.contract).toLowerCase() ? "direct" : "indirect";
        if (saved.has(route)) continue;
        const receipt = await rpc(i.chain).call("eth_getTransactionReceipt", [t.hash]);
        if (!receipt || receipt.status !== "0x1") continue;
        const ctx = { chain: i.chain, identities: [i] };
        if (lp) {
          ctx.lpPositions = {};
          for (const nft of parseTokenTransfers(receipt.logs).filter(x => x.kind === "erc721" && x.from === "0x0000000000000000000000000000000000000000" && x.token.toLowerCase() === i.receiptToken.toLowerCase()).slice(0, 20)) {
            try {
            const fragment = positionFragment(i.details.protocol === "uniswap"), abi = parseAbi([fragment]);
            const { encodeFunctionData } = await import("viem");
            const data = await rpc(i.chain).call("eth_call", [{ to: i.receiptToken, data: encodeFunctionData({ abi, functionName: "positions", args: [nft.tokenId] }) }, receipt.blockNumber]);
            const p = decodeFunctionResult({ abi, functionName: "positions", data });
            if (p[2].toLowerCase() !== i.details.token0.toLowerCase() || p[3].toLowerCase() !== i.details.token1.toLowerCase()) continue;
            let identity = i;
            if (Number(p[4]) !== Number(i.details.protocol === "uniswap" ? i.details.fee : i.details.spacing)) {
              const poolAbi = parseAbi([`function getPool(address,address,${i.details.protocol === "uniswap" ? "uint24" : "int24"}) view returns (address)`]);
              const rawPool = await rpc(i.chain).call("eth_call", [{ to: i.provenance.registry, data: encodeFunctionData({ abi: poolAbi, functionName: "getPool", args: [p[2], p[3], p[4]] }) }, receipt.blockNumber]);
              const pool = getAddress(`0x${rawPool.slice(-40)}`);
              identity = await r.identify(pool, i.chain, rpc(i.chain), { block: receipt.blockNumber });
              if (!identity) continue;
              if (!ctx.identities.some(x => x.contract.toLowerCase() === pool.toLowerCase())) ctx.identities.push(identity);
            }
            ctx.lpPositions[`${i.receiptToken.toLowerCase()}:${nft.tokenId}`] = { pool: identity.contract, token0: p[2], token1: p[3], tickLower: Number(p[5]), tickUpper: Number(p[6]) };
            } catch { /* A position minted and burned in one receipt may have no remaining state. */ }
          }
        }
        const expected = r.recognise(receipt, ctx).filter(a => a.kind === "enter" && (lp || a.contract.toLowerCase() === i.contract.toLowerCase()));
        if (!expected.length) continue;
        // Raw transaction and receipt remain alongside the expected action for review.
        const result = { generatedAt: new Date().toISOString(), labels: ["OBSERVED"], name: fixture.name, family: i.family, chain: i.chain, route, tx, receipt, context: ctx, expected };
        await writeFile(new URL(`${fixture.name}-${route}.json`, dest), JSON.stringify(result, null, 2) + "\n");
        saved.set(route, t.hash);
        if (saved.size === 2) break;
      }
      if (!list.pageKey) break; pageKey = list.pageKey;
    }
    if (saved.size !== 2) { failures++; console.error(JSON.stringify({ name: fixture.name, status: "incomplete", routes: [...saved.keys()], inspected: inspected.size })); }
    else console.log(JSON.stringify({ name: fixture.name, status: "passed", receipts: Object.fromEntries(saved), inspected: inspected.size }));
  } catch (error) { failures++; console.error(JSON.stringify({ name: fixture.name, status: "failed", reason: error.reason ?? error.message?.slice(0, 120) })); }
}
if (failures) process.exitCode = 1;
