import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { JsonRpc, discoverReceipt, recipe } from "../dist/core.mjs";
import p from "../core/provenance.json" with { type: "json" };
const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!key) throw new Error("Local credential missing");
const rpc = () => new JsonRpc("base", { headers: { authorization: `Bearer ${key}` }, maxRequests: 32 });
for (const [protocol, deployment] of Object.entries(p.lp)) {
  const page = await rpc().call("alchemy_getAssetTransfers", [{ fromBlock: "0x0", toBlock: "latest", fromAddress: "0x0000000000000000000000000000000000000000", contractAddresses: [deployment.npm], category: ["erc721"], order: "desc", maxCount: "0x64" }]);
  let count = 0, inspected = 0;
  for (const hash of [...new Set(page.transfers.map(t => t.hash))]) {
    if (++inspected > 30 || count >= 2) break;
    try {
    const [tx, receipt] = await rpc().batch([{ method: "eth_getTransactionByHash", params: [hash] }, { method: "eth_getTransactionReceipt", params: [hash] }]);
    if (!receipt || receipt.status !== "0x1") continue;
    const d = await discoverReceipt("base", receipt, rpc(), { listing: async () => undefined });
    const expected = recipe("lp-v3").recognise(receipt, d.context).filter(a => a.kind === "enter");
    if (!expected.length) continue;
    const block = await rpc().call("eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (Date.now() / 1000 - Number(BigInt(block.timestamp)) > 86400) continue;
    const route = tx.to.toLowerCase() === deployment.npm.toLowerCase() ? "direct" : "indirect";
    const name = `lp-${protocol}-recent-${count++}`;
    const out = { generatedAt: new Date().toISOString(), labels: ["OBSERVED"], name, family: "lp-v3", chain: "base", route, tx, receipt, context: d.context, expected };
    await writeFile(new URL(`../test/fixtures/receipts/${name}.json`, import.meta.url), JSON.stringify(out, null, 2) + "\n");
    console.log(JSON.stringify({ name, actions: expected.length, block: receipt.blockNumber }));
    } catch (error) { console.error(JSON.stringify({ protocol, hash, skipped: error.reason ?? "unresolved" })); }
  }
  console.log(JSON.stringify({ protocol, count, inspected }));
  assert(count >= 2, "Need at least two recent recognised position receipts per protocol");
}
