import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toHex } from "viem";
import { recipe, prepareLpEntry, entryAssertions, assertPassed } from "../core/recipes/index.js";
import { assertVaultExecution } from "../core/recipes/erc4626.js";
import { centredRange, sqrtAtTick, amountsForLiquidity, spotOut } from "../core/recipes/lp-math.js";
import { encodeStep, makeStep } from "../core/encoding.js";
import { fragments } from "../core/abis.js";
import type { Identity } from "../core/recipes/types.js";
import type { Rpc } from "../core/rpc.js";
import { other, token, transfer, wallet } from "./helpers.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/recipes/${name}.json`, import.meta.url), "utf8"));
const vault = fixture("vault-base"), aave = fixture("aave-base"), lp = fixture("lp-uniswap-base"), lido = fixture("lido-ethereum"), moonwell = fixture("moonwell-base");
describe("reviewed call boundaries", () => {
  it.each([["aave-base", "0x617ba037"], ["vault-base", "0x6e553f65"], ["moonwell-base", "0xa0712d68"], ["lido-ethereum", "0xa1903eab"]])("%s uses the expected selector", (name, selector) => {
    const f = fixture(name), step = f.entry.find((s: any) => s.kind === "enter"); expect(encodeStep(step).data.slice(0, 10)).toBe(selector);
  });
  it("refuses arbitrary fragments and edited selectors", () => {
    expect(() => makeStep("enter", token, "function transfer(address,uint256)", [wallet, "1"])).toThrow("FAMILY_DISABLED");
    expect(() => encodeStep({ ...aave.entry.at(-1), selector: "0x00000000" })).toThrow("PLAN_TAMPERED");
  });
  it.each(["100000000", "500000", "0"])("sets exactly the plan amount over existing allowance %s", allowance => {
    const steps = recipe("aave-v3").buildEnter(aave.identity, wallet, "1000000", { allowance });
    expect(steps[0]?.kind).toBe("approve"); expect(steps[0]?.args[1]).toBe("1000000");
  });
  it("skips only an exactly equal allowance and supports zero-first tokens", () => {
    expect(recipe("aave-v3").buildEnter(aave.identity, wallet, "1000000", { allowance: "1000000" }).map(s => s.kind)).toEqual(["enter"]);
    const steps = recipe("aave-v3").buildEnter(aave.identity, wallet, "1000000", { allowance: "500000", zeroFirst: true });
    expect(steps.map(s => s.kind)).toEqual(["approve-zero", "approve", "enter"]); expect(steps[0]?.args[1]).toBe("0");
  });
  it("does not reuse unknown origins or paused markets", () => {
    expect(() => recipe("aave-v3").buildEnter({ ...aave.identity, provenance: { ...aave.identity.provenance, verified: false } }, wallet, "1000000")).toThrow("UNKNOWN_PROVENANCE");
    expect(() => recipe("aave-v3").buildEnter({ ...aave.identity, paused: true }, wallet, "1000000")).toThrow("PAUSED");
    expect(() => recipe("aave-v3").buildEnter({ ...aave.identity, cap: "999999" }, wallet, "1000000")).toThrow("CAP_REACHED");
    expect(() => recipe("unknown" as any)).toThrow("FAMILY_DISABLED");
  });
});
describe("vault execution policy", () => {
  it("requires verified origin, size, and listing independently", () => {
    expect(() => assertVaultExecution(vault.identity)).not.toThrow();
    for (const identity of [
      { ...vault.identity, provenance: { ...vault.identity.provenance, verified: false } },
      { ...vault.identity, provenance: { ...vault.identity.provenance, listed: false } },
      { ...vault.identity, details: { ...vault.identity.details, sizeUsdMicros: "99999999999" } },
    ]) expect(() => assertVaultExecution(identity)).toThrow();
  });
  it("refuses the known tiny-vault case even with factory origin", () => {
    const tiny: Identity = { ...vault.identity, contract: "0x283ca12dfd7da7522d7a9e3994afb8c7f3143cc4", provenance: { ...vault.identity.provenance, listed: false }, details: { ...vault.identity.details, sizeUsdMicros: "50" } };
    expect(() => assertVaultExecution(tiny)).toThrow("TOO_SMALL");
  });
  it("uses simulation-based cap mode only after a successful V2 factory check", () => {
    expect(vault.identity.cap).toBe("0"); expect(vault.identity.details.capMode).toBe("simulated-round-trip");
    expect(vault.identity.provenance.registry.toLowerCase()).toBe("0x4501125508079a99ebbebce205dec9593c2b5857");
    expect(() => recipe("erc4626").buildEnter(vault.identity, wallet, "1000000")).not.toThrow();
    expect(() => recipe("erc4626").buildEnter({ ...vault.identity, details: { ...vault.identity.details, capMode: "maxDeposit" } }, wallet, "1000000")).toThrow("CAP_REACHED");
  });
  it("retains maxDeposit for MetaMorpho v1 and named vaults", () => {
    for (const name of ["vault-v1-base", "spark-base", "fluid-base"]) {
      const i = fixture(name).identity; expect(i.details.capMode).toBe("maxDeposit");
      expect(() => recipe("erc4626").buildEnter({ ...i, cap: "0" }, wallet, "1000000")).toThrow("CAP_REACHED");
    }
  });
  it("the V2 exception does not skip simulation failures", () => {
    const sim = structuredClone(vault.preview); sim.calls[vault.entry.length - 1].transfers = [];
    expect(() => assertPassed(entryAssertions(recipe("erc4626"), vault.checkedIdentity, vault.wallet, vault.amount, sim, vault.entry.length, vault.permissionReads))).toThrow("SIM_FAILED");
  });
});
describe("entry assertion failures", () => {
  it("rejects leftover permissions", () => {
    expect(() => assertPassed(entryAssertions(recipe("aave-v3"), aave.checkedIdentity, aave.wallet, aave.amount, aave.preview, aave.entry.length, [{ ...aave.permissionReads[0], amount: "1" }]))).toThrow("ALLOWANCE_ZERO");
  });
  it("rejects any undeclared outgoing token", () => {
    const sim = structuredClone(aave.preview); sim.calls[0].transfers.push({ kind: "erc20", token: other, from: aave.wallet, to: other, amount: "1" });
    expect(() => assertPassed(entryAssertions(recipe("aave-v3"), aave.checkedIdentity, aave.wallet, aave.amount, sim, aave.entry.length, aave.permissionReads))).toThrow("NO_OTHER_OUT");
  });
  it("rejects a nonzero Moonwell code despite a successful EVM status and mint event", () => {
    const sim = structuredClone(moonwell.preview); sim.calls[moonwell.entry.length - 1].returnData = toHex(1n, { size: 32 });
    expect(() => assertPassed(entryAssertions(recipe("moonwell"), moonwell.identity, moonwell.wallet, moonwell.amount, sim, moonwell.entry.length, moonwell.permissionReads))).toThrow("RETURN_CODE");
  });
  it("rejects an NFT minted to another wallet", () => {
    const sim = structuredClone(lp.preview); for (const c of sim.calls) for (const t of c.transfers) if (t.kind === "erc721") t.to = other;
    expect(() => assertPassed(entryAssertions(recipe("lp-v3"), lp.identity, lp.wallet, lp.amount, sim, lp.entry.steps.length, lp.permissionReads))).toThrow("NFT_OWNER");
  });
});
describe("market and queued exits", () => {
  it("requires explicit exit acceptance", async () => {
    expect(() => recipe("lst").buildEnter(lido.identity, wallet, "1000")).toThrow("EXIT_NOT_ACCEPTED");
    expect(() => recipe("lp-v3").buildEnter(lp.identity, wallet, "1000000")).toThrow("EXIT_NOT_ACCEPTED");
    await expect(prepareLpEntry(lp.identity, wallet, "1000000", {} as Rpc, {})).rejects.toThrow("EXIT_NOT_ACCEPTED");
  });
  it("rejects a swap quote with impact above 0.5%", async () => {
    const result = encodeAbiParameters([{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }], [1n, BigInt(lp.identity.details.sqrtPriceX96), 0, 1n]);
    const rpc = { call: async () => result } as unknown as Rpc;
    await expect(prepareLpEntry(lp.identity, wallet, "1000000", rpc, { acceptExit: "market", halfWidthTicks: 600 })).rejects.toThrow("impact exceeds");
  });
  it("recentres the copied width on today's tick", () => {
    const tick = Number(lp.identity.details.tick) + 2000;
    const identity = { ...lp.identity, details: { ...lp.identity.details, tick, sqrtPriceX96: sqrtAtTick(tick).toString() } };
    const steps = recipe("lp-v3").buildEnter(identity, wallet, "1000000", { acceptExit: "market", halfWidthTicks: 600, amount0: "1000000000000000", amount1: "500000", now: lp.options.now });
    const mint = steps.find(s => s.kind === "enter")!.args[0] as Record<string, number>;
    expect(mint.tickLower).toBeLessThan(tick); expect(mint.tickUpper).toBeGreaterThan(tick);
    expect(mint.tickLower).not.toBe(lp.entry.steps.find((s: any) => s.kind === "enter").args[0].tickLower);
  });
  it("uses one multicall for decrease and collection, with a fixed recipient", () => {
    const steps = recipe("lp-v3").buildExit(lp.identity, wallet, "all", lp.exitOptions);
    expect(steps).toHaveLength(1); expect(steps[0]?.selector).toBe("0xac9650d8");
    const data = steps[0]?.args[0] as string[]; expect(data).toHaveLength(2); expect(data[1]?.slice(0, 10)).toBe("0xfc6f7865");
  });
  it("bounds ticks and keeps token math in integers", () => {
    expect(sqrtAtTick(0)).toBe(1n << 96n);
    expect(centredRange(-1, 600, 10)).toEqual({ lower: -610, upper: 600 });
    expect(() => centredRange(0, 1, 10)).toThrow(); expect(() => sqrtAtTick(887273)).toThrow();
    const amounts = amountsForLiquidity(1n << 96n, -600, 600, 10n ** 12n); expect(amounts.amount0).toBeGreaterThan(0n); expect(amounts.amount1).toBeGreaterThan(0n);
    expect(spotOut(9007199254740993n, 1n << 96n, true)).toBe(9007199254740993n);
  });
});


describe("Compound borrowing guards", () => {
  const f = fixture("compound-base"), r = recipe("compound-v3");
  it("refuses entry without a fresh debt-free wallet read", () => {
    for (const details of [{ ...f.identity.details, borrowBalance: "1" }, { ...f.identity.details, wallet: other }])
      expect(() => r.buildEnter({ ...f.identity, details }, f.wallet, "1000000")).toThrow("SIM_FAILED");
  });
  it("refuses a withdrawal that could borrow", () => {
    expect(() => r.buildExit(f.identity, f.wallet, "1000000")).toThrow("INSUFFICIENT_BALANCE");
    expect(() => r.buildExit(f.identity, f.wallet, "1000000", { positionBalance: "999999" })).toThrow("INSUFFICIENT_BALANCE");
    expect(() => r.buildExit(f.identity, f.wallet, "1000000", { positionBalance: "1000000" })).not.toThrow();
  });
});
