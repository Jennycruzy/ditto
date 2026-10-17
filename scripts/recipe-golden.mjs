import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { encodeFunctionData, erc20Abi, getAddress, toHex } from "viem";
import { JsonRpc, dryRunOverrides, simulate, recipe, encodeStep, makeStep, normalizedIncomeFragment, entryAssertions, assertPassed, exitMinimum } from "../dist/core.mjs";
import provenance from "../core/provenance.json" with { type: "json" };

const burner = getAddress("0x000000000000000000000000000000000000d177");
const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!key) throw new Error("Missing local RPC credential");
const headers = { authorization: `Bearer ${key}` };
const fixtures = new URL("../test/fixtures/recipes/", import.meta.url);
await mkdir(fixtures, { recursive: true });
const rpc = chain => new JsonRpc(chain, { headers, maxRequests: 32 });
function recording(chain) {
  const calls = [];
  return { calls, call: async (method, params) => {
    const result = await rpc(chain).call(method, params); calls.push({ method, params, result }); return result;
  }, batch: async inputs => {
    const results = await rpc(chain).batch(inputs);
    inputs.forEach((input, i) => calls.push({ ...input, result: results[i] })); return results;
  } };
}
async function listing(contract, chain) {
  const chainId = { base: 8453, arbitrum: 42161, optimism: 10, ethereum: 1 }[chain];
  const r = await fetch("https://api.morpho.org/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `query { vaultV2ByAddress(address:"${contract}",chainId:${chainId}) { listed totalAssetsUsd } }` }), signal: AbortSignal.timeout(3500) });
  const body = await r.json(); let v = body.data?.vaultV2ByAddress;
  if (!v) {
    const legacy = await fetch("https://api.morpho.org/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `query { vaultByAddress(address:"${contract}",chainId:${chainId}) { listed state { totalAssetsUsd } } }` }), signal: AbortSignal.timeout(3500) });
    const b = await legacy.json(); if (b.data?.vaultByAddress) v = { listed: b.data.vaultByAddress.listed, totalAssetsUsd: b.data.vaultByAddress.state?.totalAssetsUsd };
  }
  return v ? { address: contract, chain, listed: v.listed, totalAssetsUsd: String(v.totalAssetsUsd), fetchedAt: new Date().toISOString() } : undefined;
}
const targets = [
  ["aave-base", "aave-v3", "base", provenance.aave.base.pool],
  ["vault-base", "erc4626", "base", "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9"],
  ["vault-second-base", "erc4626", "base", "0xbeeff2490feffa212fac2f6553682c219e6a8845"],
  ["vault-v1-base", "erc4626", "base", "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61"],
  ["compound-base", "compound-v3", "base", provenance.compound.base.comet],
  ["moonwell-base", "moonwell", "base", provenance.moonwell.base.market],
  ["spark-base", "erc4626", "base", provenance.namedVaults[0].address],
  ["fluid-base", "erc4626", "base", provenance.namedVaults[1].address],
  ["lido-ethereum", "lst", "ethereum", provenance.lido.steth],
  ["wsteth-ethereum", "lst", "ethereum", provenance.lido.wsteth],
  ["aave-arbitrum", "aave-v3", "arbitrum", provenance.aave.arbitrum.pool],
  ["aave-optimism", "aave-v3", "optimism", provenance.aave.optimism.pool],
  ["compound-arbitrum", "compound-v3", "arbitrum", provenance.compound.arbitrum.comet],
  ["compound-optimism", "compound-v3", "optimism", provenance.compound.optimism.comet],
  ["moonwell-optimism", "moonwell", "optimism", provenance.moonwell.optimism.market],
  ["spark-arbitrum", "erc4626", "arbitrum", provenance.namedVaults[2].address],
  ["vault-optimism", "erc4626", "optimism", "0xc30ce6a5758786e0f640cc5f881dd96e9a1c5c59"],
];
const pinned = process.argv.includes("--pinned"), selected = process.argv.slice(2).filter(a => a !== "--pinned");
let failures = 0;
for (const [name, family, chain, rawAddress] of targets) {
  if (selected.length && !selected.includes(name)) continue;
  try {
    const contract = getAddress(rawAddress), rec = recording(chain), r = recipe(family);
    let block;
    if (pinned) { try { block = JSON.parse(await readFile(new URL(`${name}.json`, fixtures), "utf8")).block; } catch {} }
    block ??= await rec.call("eth_blockNumber", []);
    const options = { block, wallet: burner, ...(family === "erc4626" ? { listing: await listing(contract, chain) } : {}) };
    const identity = await r.identify(contract, chain, rec, options);
    assert(identity); assert(identity.provenance.verified);
    let amount = family === "lst" ? "1000000000000000" : "1000000";
    const asCall = s => ({ ...encodeStep(s), from: burner, value: toHex(BigInt(s.value)) });
    const balanceCall = token => ({ from: burner, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [burner] }) });
    const overrides = family === "lst" ? { [burner]: { balance: toHex(10n ** 16n) } } : dryRunOverrides(burner, identity.asset, BigInt(amount), 9n);
    const prelude = identity.details.wrapped ? [makeStep("enter", getAddress(provenance.lido.steth), "function submit(address referral) payable returns (uint256)", ["0x0000000000000000000000000000000000000000"], [], amount)] : [];
    let preludePreview;
    if (prelude.length) {
      preludePreview = await simulate(rec, [...prelude.map(asCall), balanceCall(identity.asset)], { block, stateOverrides: overrides });
      amount = BigInt(preludePreview.calls.at(-1).returnData).toString();
    }
    const entry = r.buildEnter(identity, burner, amount, { allowance: "0", acceptExit: "queued" });
    const allowanceRead = (token, spender) => ({ from: burner, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [burner, spender] }) });
    const entryProbes = [balanceCall(identity.receiptToken), ...(identity.asset !== "native" ? [allowanceRead(identity.asset, identity.contract)] : [])];
    if (family === "aave-v3") entryProbes.push({ from: burner, to: identity.contract, data: encodeFunctionData({ abi: (await import("viem")).parseAbi([normalizedIncomeFragment]), functionName: "getReserveNormalizedIncome", args: [identity.asset] }) });
    if (family === "erc4626") entryProbes.push({ from: burner, to: identity.contract, data: encodeFunctionData({ abi: (await import("viem")).parseAbi(["function previewDeposit(uint256) view returns (uint256)"]), functionName: "previewDeposit", args: [BigInt(amount)] }) });
    const combinedPreview = await simulate(rec, [...prelude.map(asCall), ...entry.map(asCall), ...entryProbes], { block, stateOverrides: overrides });
    const preview = { ...combinedPreview, calls: combinedPreview.calls.slice(prelude.length) };
    const shares = BigInt(preview.calls[entry.length].returnData).toString(); assert(BigInt(shares) > 0n);
    const checkedIdentity = family === "aave-v3" ? { ...identity, details: { ...identity.details, normalizedIncome: BigInt(preview.calls.at(-1).returnData).toString(), normalizedIncomeBlock: preview.block } } : family === "erc4626" ? { ...identity, details: { ...identity.details, previewShares: BigInt(preview.calls.at(-1).returnData).toString(), previewFor: amount, previewBlock: preview.block } } : identity;
    const permissionReads = identity.asset === "native" ? [] : [{ token: identity.asset, spender: identity.contract, amount: BigInt(preview.calls[entry.length + 1].returnData).toString() }];
    const assertions = entryAssertions(r, checkedIdentity, burner, amount, preview, entry.length, permissionReads);
    assertPassed(assertions);
    const exit = r.buildExit(identity, burner, family === "aave-v3" || family === "compound-v3" ? "all" : shares, { shares: true, allowance: "0", acceptExit: "queued" });
    const allowanceCall = identity.asset === "native" ? allowanceRead(identity.receiptToken, getAddress(provenance.lido.queue)) : allowanceRead(identity.asset, identity.contract);
    const fullCalls = [...prelude.map(asCall), ...entry.map(asCall), ...exit.map(asCall), balanceCall(identity.receiptToken), allowanceCall, ...(identity.asset !== "native" ? [balanceCall(identity.asset)] : []), ...(family === "lst" ? [allowanceRead(identity.receiptToken, getAddress(provenance.lido.queue))] : [])];
    const full = await simulate(rec, fullCalls, { block, stateOverrides: overrides });
    if (family !== "lst") {
      assert.equal(BigInt(full.calls.at(-2).returnData), 0n, "allowance remains");
      const returned = BigInt(full.calls.at(-1).returnData);
      assert(returned >= exitMinimum(family, BigInt(amount)), "exit below tolerance");
    } else {
      assert(full.calls[prelude.length + entry.length + exit.length - 1].transfers.some(t => t.kind === "erc721" && t.to.toLowerCase() === burner.toLowerCase()), "queue receipt missing");
      assert.equal(BigInt(full.calls.at(-1).returnData), 0n, "queue allowance remains");
    }
    assertions.push({ code: "EXIT", pass: true, detail: family === "lst" ? "Queue request and its NFT receipt simulated; no instant ETH return claimed." : "Exit meets the family tolerance." });
    const fixture = { generatedAt: new Date().toISOString(), labels: ["OBSERVED", "SIMULATED"], name, family, chain, block, wallet: burner, options, identity, checkedIdentity, amount, shares, prelude, entry, exit, preview, full, simulations: [...(preludePreview ? [preludePreview] : []), combinedPreview, full], permissionReads, assertions, rpc: rec.calls };
    await writeFile(new URL(`${name}.json`, fixtures), JSON.stringify(fixture, null, 2) + "\n");
    console.log(JSON.stringify({ name, status: "passed", shares, exitClass: family === "lst" ? "queued" : "instant", block }));
  } catch (error) { failures++; console.error(JSON.stringify({ name, status: "failed", reason: error.code ?? error.reason ?? error.message?.slice(0, 160) ?? "check failed" })); }
}
if (failures) process.exitCode = 1;
