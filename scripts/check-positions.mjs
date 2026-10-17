import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { JsonRpc, recipe, positionSchema } from "../dist/core.mjs";

const env = await readFile(resolve(homedir(), "ditto-private/.env"), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!key) throw new Error("Missing local credential");
const headers = { authorization: `Bearer ${key}` };
const source = new URL("../test/fixtures/receipts/", import.meta.url), dest = new URL("../test/fixtures/positions/", import.meta.url);
await mkdir(dest, { recursive: true });
const targets = ["aave-base-direct", "vault-base-indirect", "vault-v1-base-direct", "spark-base-direct", "fluid-base-direct", "compound-base-indirect", "compound-arbitrum-direct", "compound-optimism-direct", "moonwell-base-direct", "moonwell-base-indirect", "moonwell-optimism-direct", "lido-ethereum-direct", "wsteth-ethereum-direct", "lp-uniswap-base-direct", "lp-aerodrome-base-direct"];
let failures = 0;
const clock = Date.now;
for (const name of targets) {
  try {
    const f = JSON.parse(await readFile(new URL(`${name}.json`, source), "utf8")), action = f.expected[0], identity = f.context.identities.find(i => i.contract.toLowerCase() === action.contract.toLowerCase());
    const wallet = action.actor, block = f.receipt.blockNumber, calls = [];
    if (action.tokenId) identity.details.tokenId = action.tokenId;
    const send = async (method, params) => {
      let actual = structuredClone(params);
      if (method === "eth_blockNumber") { calls.push({ method, params, result: block }); return block; }
      actual = actual.map(v => v === "latest" ? block : v);
      const result = await new JsonRpc(f.chain, { headers, maxRequests: 32 }).call(method, actual);
      calls.push({ method, params, result }); return result;
    };
    const rpc = { call: send, batch: async inputs => { const results = []; for (const c of inputs) results.push(await send(c.method, c.params)); return results; } };
    const now = clock(); Date.now = () => now;
    const position = positionSchema.parse(await recipe(f.family).position(identity, wallet, rpc));
    if (BigInt(position.balance.atomic) === 0n) assert.equal(position.exitPreview.pass, false);
    else assert(BigInt(position.valueNow.atomic) > 0n);
    const out = { generatedAt: new Date().toISOString(), labels: ["OBSERVED", "SIMULATED", "HISTORICAL"], name, now, family: f.family, chain: f.chain, identity, wallet, block, position, rpc: calls };
    await writeFile(new URL(`${name}.json`, dest), JSON.stringify(out, null, 2) + "\n");
    console.log(JSON.stringify({ name, status: "passed", exitClass: position.exitPreview.exitClass, exitPass: position.exitPreview.pass }));
  } catch (error) { failures++; console.error(JSON.stringify({ name, status: "failed", reason: error.reason ?? error.message?.slice(0, 120) })); }
}
if (failures) process.exitCode = 1;
