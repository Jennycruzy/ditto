import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { JsonRpc, dryRunOverrides, simulate, usdcAddress, displayAmount } from "../dist/core.mjs";

// This script only reads the chain and simulates calls. It cannot sign or broadcast.
async function main() {
  const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
  const match = env.match(/^ALCHEMY_API_KEY=(.+)$/m);
  if (!match) throw new Error("Local RPC credential missing");
  const key = match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
  const options = { headers: { authorization: `Bearer ${key}` } };
  const wallet = "0x62cd77f1b851a1df9aaadcdcf49e107f887d4dd4";
  const burner = "0x000000000000000000000000000000000000d177";
  const recipient = "0x000000000000000000000000000000000000d178";
  const usdc = usdcAddress("base");
  const word = v => BigInt(v).toString(16).padStart(64, "0");
  const addrWord = a => a.slice(2).toLowerCase().padStart(64, "0");
  const balanceData = a => `0x70a08231${addrWord(a)}`;
  const rpc = new JsonRpc("base", options);
  const [block, eth, balance] = await rpc.batch([
    { method: "eth_blockNumber", params: [] },
    { method: "eth_getBalance", params: [wallet, "latest"] },
    { method: "eth_call", params: [{ to: usdc, data: balanceData(wallet) }, "latest"] },
  ]);
  const sim = await simulate(rpc, [
    { from: burner, to: usdc, data: balanceData(burner) },
    { from: burner, to: usdc, data: `0xa9059cbb${addrWord(recipient)}${word(1_000_000n)}` },
    { from: burner, to: usdc, data: balanceData(burner) },
    { from: burner, to: recipient, data: "0x", value: "0x1" },
  ], { block, stateOverrides: dryRunOverrides(burner, usdc, 1_000_000n, 9n) });
  assert.equal(BigInt(sim.calls[0].returnData), 1_000_000n);
  assert.equal(BigInt(sim.calls[2].returnData), 0n);
  assert.equal(sim.calls[1].transfers.length, 1);
  assert.equal(sim.calls[1].transfers[0].amount, "1000000");
  assert.equal(sim.calls[1].transfers[0].token, usdc);
  assert.equal(sim.calls[3].transfers.length, 1);
  assert.equal(sim.calls[3].transfers[0].kind, "native");
  assert.equal(sim.calls[3].transfers[0].amount, "1");
  // A new client gives the independent after-read its own bounded operation.
  const after = await new JsonRpc("base", options).batch([
    { method: "eth_getBalance", params: [wallet, "latest"] },
    { method: "eth_call", params: [{ to: usdc, data: balanceData(wallet) }, "latest"] },
  ]);
  assert.equal(after[0], eth); assert.equal(after[1], balance);
  const report = {
    generatedAt: new Date().toISOString(), chain: "base", labels: ["OBSERVED", "SIMULATED"],
    block: BigInt(block).toString(), simulatedBlock: sim.block,
    checks: { balanceOverride: true, sequentialState: true, erc20Trace: true, nativeTrace: true, walletBalancesUnchanged: true },
    wallet, balances: { usdc: { atomic: BigInt(balance).toString(), display: displayAmount(BigInt(balance).toString(), 6) }, eth: { atomic: BigInt(eth).toString(), display: displayAmount(BigInt(eth).toString(), 18) } },
    simulatedCalls: sim.calls.map(c => ({ gasUsed: c.gasUsed, transfers: c.transfers })),
    moneySpent: { atomic: "0", display: "0" },
  };
  await mkdir(new URL("../evidence/", import.meta.url), { recursive: true });
  await writeFile(new URL("../evidence/core-check.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
main().catch(() => { console.error("Core chain check failed; no transaction was signed or sent."); process.exitCode = 1; });
