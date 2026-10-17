// pnpm verify: re-read every live proof in evidence/proofs from the chain's PUBLIC RPC (no key) and re-check it.
import { readdir, readFile } from "node:fs/promises";
const rpcs = { base: "https://mainnet.base.org", arbitrum: "https://arb1.arbitrum.io/rpc", optimism: "https://mainnet.optimism.io", ethereum: "https://ethereum-rpc.publicnode.com" };
const usdc = { base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const dir = new URL("../evidence/proofs/", import.meta.url);
let failed = 0;
for (const name of (await readdir(dir)).filter(n => n.endsWith(".json")).sort()) {
  const p = JSON.parse(await readFile(new URL(name, dir), "utf8")), wallet = p.wallet.toLowerCase(), all = [...p.enter.hashes, ...p.exit.hashes];
  const res = await (await fetch(rpcs[p.chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(all.map((h, id) => ({ jsonrpc: "2.0", id, method: "eth_getTransactionReceipt", params: [h] }))) })).json();
  const receipts = all.map((_, id) => res.find(r => r.id === id)?.result);
  const flow = hashes => hashes.reduce((acc, h) => { for (const l of receipts[all.indexOf(h)]?.logs ?? []) if (l.address.toLowerCase() === usdc[p.chain] && l.topics[0] === TRANSFER) { const v = BigInt(l.data); if (`0x${l.topics[1].slice(26)}` === wallet) acc.out += v; if (`0x${l.topics[2].slice(26)}` === wallet) acc.back += v; } return acc; }, { out: 0n, back: 0n });
  const checks = {
    allSucceeded: receipts.every(r => r?.status === "0x1"),
    signedByWallet: receipts.every(r => r?.from?.toLowerCase() === wallet),
    exactlyOneUsdcIn: flow(p.enter.hashes).out === 1_000_000n,
    atLeast0999Back: flow(p.exit.hashes).back >= 999_000n,
  };
  const ok = Object.values(checks).every(Boolean); if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name.replace(".json", "")} ${JSON.stringify(checks)}`);
}
if (failed) process.exit(1);
