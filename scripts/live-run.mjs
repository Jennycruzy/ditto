// Live runs (SPEC §20.4, CP7): enter with a signed plan, prove it, exit, prove it. Real money, ≤1 USDC per run.
// Signing uses the PayBox CLI (the paired wallet key signs in-process; nothing is broadcast by PayBox). Every signed
// transaction is decoded and must match Ditto's proposed step exactly before it is broadcast.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseTransaction, getAddress } from "viem";
import { JsonRpc, ExecutionEngine, buildExitPlan, verifyExecution, evidenceWithFallback } from "../dist/core.mjs";

const run = promisify(execFile);
const [family, contract, label] = process.argv.slice(2);
if (!family || !contract) throw new Error("usage: live-run.mjs <family> <contract> <label>");
const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim();
const wallet = getAddress("0x62cd77f1b851a1df9aaadcdcf49e107f887d4dd4"), credential = "ca856117-751e-4a8d-befe-86e3158783ed", chain = "base";
const MIN_ETH = 200000000000000n; // hard stop 0.0002 ETH (SPEC §22)
const client = () => new JsonRpc(chain, { headers: { authorization: `Bearer ${key}` }, maxRequests: 256 });
const rpc = { call: (m, p) => client().call(m, p), batch: c => client().batch(c) };
const atlas = async (_c, address) => {
  try { const a = await (await fetch("https://jennycruzy.github.io/ditto-atlas/atlas/base.json", { signal: AbortSignal.timeout(4000) })).json(); return a.rows.find(r => r.contract.toLowerCase() === address.toLowerCase())?.evidence; } catch { return undefined; }
};
const engine = new ExecutionEngine(rpc, { planKey: randomBytes(32).toString("hex"), maxAmount: "1", evidence: evidenceWithFallback(atlas) });
const log = [];
const say = (...a) => { const line = a.join(" "); log.push(line); console.log(line); };

async function signAndSend(tx) {
  const eth = BigInt(await rpc.call("eth_getBalance", [wallet, "latest"]));
  if (eth < MIN_ETH) throw new Error(`STOP: ETH ${eth} below the 0.0002 hard stop`);
  const [nonce, block, tip] = await Promise.all([rpc.call("eth_getTransactionCount", [wallet, "pending"]), rpc.call("eth_getBlockByNumber", ["latest", false]), rpc.call("eth_maxPriorityFeePerGas", [])]);
  const estimate = BigInt(await rpc.call("eth_estimateGas", [{ from: wallet, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value).toString(16)}` }]));
  const gas = estimate * 13n / 10n + 5000n, priority = BigInt(tip) > 1000000n ? BigInt(tip) : 1000000n, maxFee = BigInt(block.baseFeePerGas) * 2n + priority;
  if (gas * maxFee > eth / 4n) throw new Error(`STOP: worst-case fee ${gas * maxFee} is over a quarter of the ETH balance`);
  const intent = { op: "transaction", transaction: { type: "eip1559", chainId: 8453, nonce: Number(BigInt(nonce)), to: tx.to, value: String(BigInt(tx.value)), data: tx.data, gas: gas.toString(), maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: priority.toString() } };
  const { stdout } = await run("npx", ["paybox", "--json", "sign", "--credential", credential, "--intent", JSON.stringify(intent)], { cwd: resolve(homedir(), "ditto-private/paybox-cli"), timeout: 120000 });
  const raw = JSON.parse(stdout)?.output?.value?.serializedTransaction;
  if (!raw) throw new Error(`Signing did not return a transaction: ${stdout.slice(0, 300)}`);
  const parsed = parseTransaction(raw);
  // Decode before broadcast: anything other than exactly the proposed step is refused.
  if (getAddress(parsed.to) !== getAddress(tx.to) || (parsed.data ?? "0x").toLowerCase() !== tx.data.toLowerCase() || (parsed.value ?? 0n) !== BigInt(tx.value) || parsed.chainId !== 8453 || parsed.nonce !== Number(BigInt(nonce))) throw new Error("STOP: signed transaction differs from the proposed step");
  say(`  signed: to ${parsed.to} selector ${tx.data.slice(0, 10)} value ${parsed.value ?? 0n} nonce ${parsed.nonce} gas ${gas} maxFee ${maxFee}`);
  // Broadcast directly: the plugin's RPC client deliberately has no send method.
  const sent = await (await fetch("https://base-mainnet.g.alchemy.com/v2", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }) })).json();
  if (!sent.result) throw new Error(`STOP: broadcast failed ${JSON.stringify(sent.error)}`);
  const hash = sent.result;
  for (let i = 0; i < 60; i++) {
    const receipt = await rpc.call("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (receipt) { say(`  ${receipt.status === "0x1" ? "confirmed" : "REVERTED"} ${hash} block ${BigInt(receipt.blockNumber)} fee ${(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + BigInt(receipt.l1Fee ?? "0x0"))} wei`); if (receipt.status !== "0x1") throw new Error("STOP: transaction reverted"); return hash; }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`STOP: no receipt for ${hash}`);
}
async function execute(plan, name) {
  const hashes = [];
  for (let n = 0; n < 10; n++) {
    const s = await engine.step({ plan, wallet, txHashes: hashes });
    if (s.done) break;
    if (!s.transaction) throw new Error(`STOP: ${s.text}`);
    say(`${name}: ${s.text.split(" Select PayBox")[0]}`);
    hashes.push(await signAndSend(s.transaction));
  }
  for (let i = 0; i < 5; i++) {
    const v = await verifyExecution(engine, { plan, txHashes: hashes });
    if (v.proof?.landed || i === 4) { say(v.text); return { plan, hashes, proof: v.proof, text: v.text }; }
    await new Promise(r => setTimeout(r, 3000)); // let the reading RPC catch up with the confirming one
  }
}
process.on("uncaughtException", e => { console.error(`FAILED: ${String(e?.message ?? e).slice(0, 600)}`); process.exit(1); });
process.on("unhandledRejection", e => { console.error(`FAILED: ${String(e?.message ?? e).slice(0, 600)}`); process.exit(1); });
const accept = family === "lst" ? { acceptExit: "queued" } : family === "lp-v3" ? { acceptExit: "market" } : {};
const planned = await engine.enter({ chain, family, contract, wallet, amount: "1", ...accept });
say(planned.text.split(" Pass this signed plan")[0]);
if (planned.verdict !== "ok") throw new Error(`Refused: ${planned.text}`);
const enter = await execute(planned.plan, "enter");
const exitPlan = await buildExitPlan(engine, { chain, family, contract, wallet, amount: "all", ...accept });
say(exitPlan.text.split(" Pass this signed plan")[0]);
if (exitPlan.verdict !== "ok") throw new Error(`Exit refused: ${exitPlan.text}`);
const exit = await execute(exitPlan.plan, "exit");
await mkdir(new URL("../evidence/proofs/", import.meta.url), { recursive: true });
const out = { label, family, chain, contract, wallet, generatedAt: new Date().toISOString(), labels: ["OBSERVED", "LIVE"], enter, exit, log };
await writeFile(new URL(`../evidence/proofs/${label}.json`, import.meta.url), JSON.stringify(out, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
console.log(JSON.stringify({ label, enterLanded: enter.proof?.landed, exitLanded: exit.proof?.landed, hashes: [...enter.hashes, ...exit.hashes] }));
