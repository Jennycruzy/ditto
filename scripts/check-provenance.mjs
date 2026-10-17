import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { encodeFunctionData, decodeFunctionResult, getAddress, parseAbi } from "viem";
import { JsonRpc } from "../dist/core.mjs";
import p from "../core/provenance.json" with { type: "json" };

const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!key) throw new Error("Local credential missing");
const records = [], headers = { authorization: `Bearer ${key}` };
async function read(chain, address, fragment, args = []) {
  const abi = parseAbi([fragment]), functionName = abi[0].name;
  const rpc = new JsonRpc(chain, { headers, maxRequests: 32 });
  const block = await rpc.call("eth_blockNumber", []);
  const raw = await rpc.call("eth_call", [{ to: getAddress(address), data: encodeFunctionData({ abi, functionName, args }) }, block]);
  return { block, raw, result: decodeFunctionResult({ abi, functionName, data: raw }) };
}
for (const [chain, factory, method, vault] of [
  ["base", p.morpho.base[0].address, "isMetaMorpho", "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61"],
  ["base", p.morpho.base[1].address, "isMetaMorpho", "0xffedad42083e2eb8ca401f09c0038a9ded7ef8e5"],
  ["base", p.morpho.base[2].address, "isVaultV2", "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9"],
  ["arbitrum", p.morpho.arbitrum[0].address, "isMetaMorpho", "0xf9a4d875811682c225db58d9d0216709dcd6ebbb"],
  ["optimism", p.morpho.optimism[0].address, "isMetaMorpho", "0xc30ce6a5758786e0f640cc5f881dd96e9a1c5c59"],
]) {
  const r = await read(chain, factory, `function ${method}(address) view returns (bool)`, [vault]);
  assert.equal(r.result, true);
  records.push({ chain, factory, method, vault, block: r.block, verified: true, source: p.morpho.source });
}
for (const chain of ["base", "arbitrum"]) {
  const factory = p.euler[chain];
  const list = await read(chain, factory, "function getProxyListSlice(uint256,uint256) view returns (address[])", [0n, 1n]);
  const vault = list.result[0]; assert(vault);
  const r = await read(chain, factory, "function isProxy(address) view returns (bool)", [vault]);
  assert.equal(r.result, true);
  const asset = await read(chain, vault, "function asset() view returns (address)");
  records.push({ chain, factory, method: "isProxy", vault, asset: asset.result, block: r.block, verified: true, source: p.euler.source });
}
const report = { generatedAt: new Date().toISOString(), labels: ["OBSERVED"], records, moneySpent: "0" };
await writeFile(new URL("../evidence/provenance-check.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: "passed", factories: records.length }));
