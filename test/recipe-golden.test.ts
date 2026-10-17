import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { toHex, type Address } from "viem";
import { recipe, entryAssertions, assertPassed, prepareLpEntry, exitMinimum, aaveMinimum } from "../core/recipes/index.js";
import { encodeStep } from "../core/plan.js";
import { simulate } from "../core/simulate.js";
import type { Rpc, RpcCall } from "../core/rpc.js";
import type { Family, Identity } from "../core/recipes/types.js";
import { canonicalJson } from "../core/plan.js";

const dir = new URL("./fixtures/recipes/", import.meta.url);
const fixtures = readdirSync(dir).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(new URL(n, dir), "utf8")));
function replay(fixture: { rpc: (RpcCall & { result: unknown })[] }): Rpc {
  const result = (method: string, params: readonly unknown[]) => {
    const match = fixture.rpc.find(r => r.method === method && canonicalJson(r.params) === canonicalJson(params));
    if (!match) throw new Error(`Fixture has no recorded ${method} response`);
    return structuredClone(match.result);
  };
  return { call: async <T>(method: string, params: readonly unknown[]) => result(method, params) as T, batch: async <T>(calls: readonly RpcCall[]) => calls.map(c => result(c.method, c.params) as T) };
}
describe("recorded mainnet golden cases", () => {
  it("includes all six families and the required chains and LP protocols", () => {
    expect(new Set(fixtures.map(f => f.family)).size).toBe(6);
    for (const name of ["aave-base", "vault-base", "vault-second-base", "compound-base", "moonwell-base", "spark-base", "fluid-base", "lido-ethereum", "lp-uniswap-base", "lp-aerodrome-base", "aave-arbitrum", "aave-optimism", "compound-arbitrum", "compound-optimism", "moonwell-optimism", "spark-arbitrum", "vault-optimism"]) expect(fixtures.some(f => f.name === name), name).toBe(true);
  });
  for (const f of fixtures) {
    it(`${f.name}: identifies from recorded registry reads`, async () => {
      const identity = await recipe(f.family).identify(f.identity.contract, f.chain, replay(f), { ...f.options, block: f.block, now: Date.parse(f.generatedAt) });
      expect(identity).toEqual(f.identity);
    });
    it(`${f.name}: rebuilds entry and exit from reviewed interfaces`, async () => {
      const r = recipe(f.family);
      const steps = f.family === "lp-v3" ? (await prepareLpEntry(f.identity, f.wallet, f.amount, replay(f), f.options)).steps : r.buildEnter(f.identity, f.wallet, f.amount, { allowance: "0", acceptExit: "queued" });
      expect(steps).toEqual(f.family === "lp-v3" ? f.entry.steps : f.entry);
      const exit = r.buildExit(f.identity, f.wallet, f.family === "lp-v3" || f.family === "aave-v3" || f.family === "compound-v3" ? "all" : f.shares, f.exitOptions ?? { shares: true, allowance: "0", acceptExit: "queued" });
      expect(exit).toEqual(f.exit);
      const rawCalls = f.rpc.filter((x: RpcCall) => x.method === "eth_simulateV1")[f.prelude?.length ? 1 : 0].params[0].blockStateCalls[0].calls;
      expect(steps.map(s => ({ ...encodeStep(s), from: f.wallet, value: toHex(BigInt(s.value)) }))).toEqual(rawCalls.slice(f.prelude?.length ?? 0, (f.prelude?.length ?? 0) + steps.length));
    });
    it(`${f.name}: checks every entry expectation, including permissions and events`, () => {
      const checks = entryAssertions(recipe(f.family), f.checkedIdentity ?? f.identity, f.wallet, f.amount, f.preview, f.family === "lp-v3" ? f.entry.steps.length : f.entry.length, f.permissionReads);
      expect(checks.length).toBeGreaterThanOrEqual(4); expect(() => assertPassed(checks)).not.toThrow();
      expect(f.assertions.every((a: { pass: boolean }) => a.pass)).toBe(true);
    });
    it(`${f.name}: parses sequential simulation results without a network`, async () => {
      const sims = f.rpc.filter((x: RpcCall) => x.method === "eth_simulateV1");
      for (let n = 0; n < sims.length; n++) {
        const [payload, block] = sims[n].params;
        const result = await simulate(replay(f), payload.blockStateCalls[0].calls, { block, stateOverrides: payload.blockStateCalls[0].stateOverrides });
        expect(result).toEqual(f.simulations?.[n] ?? (n === 0 ? f.preview : n === 1 ? f.full : f.roundTrip));
      }
    });
    it(`${f.name}: exit meets the declared class and tolerance`, () => {
      if (f.family === "lp-v3") { expect(f.exit).toHaveLength(1); expect(f.exit[0].selector).toBe("0xac9650d8"); expect(BigInt(f.valueBack)).toBeGreaterThanOrEqual(990000n); expect(BigInt(f.roundTrip.calls.at(-2).returnData)).toBe(0n); expect(BigInt(f.roundTrip.calls.at(-3).returnData)).toBeGreaterThanOrEqual(990000n); }
      else if (f.family === "lst") expect(f.full.calls.some((c: any) => c.transfers.some((t: any) => t.kind === "erc721" && t.to.toLowerCase() === f.wallet.toLowerCase()))).toBe(true);
      else expect(BigInt(f.full.calls.at(-1).returnData)).toBeGreaterThanOrEqual(exitMinimum(f.family, BigInt(f.amount)));
    });
  }
});

describe("Optimism rounding regression", () => {
  const f = fixtures.find(f => f.name === "aave-optimism")!;
  it("retains block 0x96ff445 and accepts 999998 using that block's index", () => {
    expect(f.block).toBe("0x96ff445");
    expect(aaveMinimum(1_000_000n, BigInt(f.checkedIdentity.details.normalizedIncome))).toBe(999_998n);
    expect(() => assertPassed(entryAssertions(recipe("aave-v3"), f.checkedIdentity, f.wallet, f.amount, f.preview, f.entry.length, f.permissionReads))).not.toThrow();
    expect(exitMinimum("aave-v3", 1_000_000n)).toBe(999_998n);
  });
  it("rejects 999997 even when the supply event still claims the full amount", () => {
    const sim = structuredClone(f.preview);
    for (const c of sim.calls) for (const t of c.transfers) if (t.token.toLowerCase() === f.identity.receiptToken.toLowerCase() && t.to.toLowerCase() === f.wallet.toLowerCase()) t.amount = "999997";
    const checks = entryAssertions(recipe("aave-v3"), f.checkedIdentity, f.wallet, f.amount, sim, f.entry.length, f.permissionReads);
    expect(checks.find(c => c.code === "RECEIPT_IN")?.pass).toBe(false);
    expect(() => assertPassed(checks)).toThrow("RECEIPT_IN");
    expect(999997n >= exitMinimum("aave-v3", 1_000_000n)).toBe(false);
  });
  it("requires the income index for the simulation's own block", () => expect(() => recipe("aave-v3").expect(f.identity, f.wallet, f.amount, f.preview)).toThrow("income index"));
  it("retains the two-unit hard floor even for unusually large indices", () => expect(aaveMinimum(1_000_000n, 5n * 10n ** 27n + 1n)).toBeGreaterThanOrEqual(999998n));
});

describe("real receipt recognition", () => {
  const receiptDir = new URL("./fixtures/receipts/", import.meta.url);
  const receipts = readdirSync(receiptDir).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(new URL(n, receiptDir), "utf8")));
  for (const f of receipts) it(`${f.name} ${f.route}: recognises the protocol event through its actual route`, () => {
    expect(recipe(f.family).recognise(f.receipt, f.context).filter(a => a.kind === "enter")).toEqual(f.expected);
    expect(f.expected.every((a: { amount: string }) => f.family === "lp-v3" ? BigInt(a.amount) >= 0n : BigInt(a.amount) > 0n)).toBe(true);
    const target = f.family === "lp-v3" ? f.context.identities[0].receiptToken : f.context.identities[0].contract;
    expect(f.tx.to.toLowerCase() === target.toLowerCase()).toBe(f.route === "direct");
  });
  it("has direct and indirect real receipts for every tested family and chain", () => {
    const groups = new Set(fixtures.map(f => `${f.family}:${f.chain}${f.family === "lp-v3" ? `:${f.identity.details.protocol}` : ""}`));
    for (const group of groups) {
      const rs = receipts.filter(f => `${f.family}:${f.chain}${f.family === "lp-v3" ? `:${f.context.identities[0].details.protocol}` : ""}` === group);
      expect(new Set(rs.map(f => f.route)), group).toEqual(new Set(["direct", "indirect"]));
    }
  });
});


describe("recorded wallet positions", () => {
  const dir = new URL("./fixtures/positions/", import.meta.url);
  const cases = readdirSync(dir).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(new URL(n, dir), "utf8")));
  for (const f of cases) it(`${f.name}: reproduces the observed exit result`, async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.now);
    try { expect(await recipe(f.family).position(f.identity, f.wallet, replay(f))).toEqual(f.position); } finally { clock.mockRestore(); }
    if (BigInt(f.position.balance.atomic) === 0n) expect(f.position.exitPreview.pass).toBe(false);
    if (!f.position.exitPreview.pass && BigInt(f.position.balance.atomic) > 0n) expect(f.position.exitPreview.detail).toContain("failed");
  });
  it("covers all six position readers", () => expect(new Set(cases.map(f => f.family)).size).toBe(6));
  it("preserves a blocked Moonwell exit and an empty Compound account", () => {
    expect(cases.find(f => f.name === "moonwell-base-direct").position.exitPreview.pass).toBe(false);
    expect(cases.find(f => f.name === "compound-base-indirect").position.balance.atomic).toBe("0");
  });
});
