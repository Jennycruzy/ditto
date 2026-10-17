import { describe, expect, it } from "vitest";
import { assertAmountLimit, assertWallet, canonicalJson, planHash, signPlan, verifyPlan } from "../core/plan.js";
import { other, now, unsignedPlan } from "./helpers.js";
const key = "12".repeat(32);

describe("canonical signed plans", () => {
  it("sorts object keys recursively, preserves array order, and matches SHA-256", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: "x" })).toBe('{"a":"x","z":[{"a":1,"b":2}]}');
    expect(planHash({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(planHash({ b: 2, a: 1 })).toBe(planHash({ a: 1, b: 2 }));
    expect(planHash([1, 2])).not.toBe(planHash([2, 1]));
  });
  it.each([undefined, NaN, Infinity, 0.5, 1n, new Date(), new Map(), { x: undefined }])("refuses noncanonical input %#", value => expect(() => canonicalJson(value)).toThrow());
  it("refuses cyclic input", () => { const x: unknown[] = []; x.push(x); expect(() => canonicalJson(x)).toThrow(); });
  it("refuses sparse, excessive and deeply nested input before validation", () => {
    expect(() => canonicalJson(new Array(2))).toThrow();
    expect(() => canonicalJson(Array.from({ length: 4097 }, () => 0))).toThrow();
    let deep: unknown = "leaf";
    for (let i = 0; i < 30; i++) deep = [deep];
    expect(() => verifyPlan(deep, key, now)).toThrow("PLAN_TAMPERED");
    expect(() => signPlan(deep, key, now)).toThrow("PLAN_TAMPERED");
  });
  it("round trips through JSON, key reordering, and independent verification", () => {
    const signed = signPlan(unsignedPlan(), key, now);
    const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(signed))).reverse());
    expect(verifyPlan(reordered, key, now)).toEqual(signed);
    expect(signPlan(unsignedPlan(), key, now)).toEqual(signed);
    expect(verifyPlan(signed, key, now + 1_799_999)).toEqual(signed);
  });
  it.each([
    (p: any) => p.amount.atomic = "2", (p: any) => p.amount.display = "2",
    (p: any) => p.wallet = other, (p: any) => p.contract = other,
    (p: any) => p.chain = "optimism", (p: any) => p.id = "b".repeat(64),
    (p: any) => p.steps[0].args[1] = "2", (p: any) => p.steps[0].to = other,
    (p: any) => p.steps[0].expect[0].amount.atomic = "2", (p: any) => p.baseline.allowance.atomic = "1",
    (p: any) => p.createdAtBlock = "99", (p: any) => p.exit.detail = "edited",
    (p: any) => p.extra = true, (p: any) => p.asset = p.asset.toLowerCase(),
    (p: any) => p.sig = "00".repeat(32), (p: any) => p.sig = "x",
  ])("rejects edited field %#", mutate => {
    const signed = signPlan(unsignedPlan(), key, now); mutate(signed);
    expect(() => verifyPlan(signed, key, now)).toThrow("PLAN_TAMPERED");
  });
  it("rejects a different HMAC key", () => expect(() => verifyPlan(signPlan(unsignedPlan(), key, now), "34".repeat(32), now)).toThrow("PLAN_TAMPERED"));
  it.each([undefined, "", "abc", "z".repeat(64)])("requires a configured 32-byte key %#", k => {
    expect(() => signPlan(unsignedPlan(), k, now)).toThrow("NOT_CONFIGURED");
    expect(() => verifyPlan({}, k, now)).toThrow("NOT_CONFIGURED");
  });
  it("rejects expired, future-created, and overlong plans", () => {
    expect(() => verifyPlan(signPlan(unsignedPlan(), key, now), key, now + 1_800_000)).toThrow("PLAN_EXPIRED");
    expect(() => signPlan(unsignedPlan(), key, now - 1)).toThrow("PLAN_EXPIRED");
    expect(() => signPlan({ ...unsignedPlan(), expiresAt: new Date(now + 1_800_001).toISOString() }, key, now)).toThrow("PLAN_EXPIRED");
  });
  it.each([["lst", "queued"], ["lp-v3", "market"]] as const)("requires acceptance of %s exit", (family, exitClass) => {
    const plan = { ...unsignedPlan(), family, exitClass, exit: { ...unsignedPlan().exit, kind: exitClass } };
    expect(() => signPlan(plan, key, now)).toThrow("EXIT_NOT_ACCEPTED");
    expect(verifyPlan(signPlan({ ...plan, acceptExit: exitClass }, key, now), key, now).acceptExit).toBe(exitClass);
  });
  it("rejects inconsistent baseline and exit declarations", () => {
    expect(() => signPlan({ ...unsignedPlan(), createdAtBlock: "101" }, key, now)).toThrow("PLAN_TAMPERED");
    expect(() => signPlan({ ...unsignedPlan(), exitClass: "market" }, key, now)).toThrow("PLAN_TAMPERED");
  });
  it("checks wallet and exact decimal amount cap without floating point", () => {
    const p = signPlan(unsignedPlan(), key, now);
    expect(() => assertWallet(p, other)).toThrow("WALLET_MISMATCH");
    expect(() => assertWallet(p, p.wallet.toLowerCase())).not.toThrow();
    expect(() => assertAmountLimit("1000000", 6, "1")).not.toThrow();
    for (const n of ["0", "-1", "1000001", "01"]) expect(() => assertAmountLimit(n, 6, "1")).toThrow("AMOUNT_OVER_LIMIT");
    expect(() => assertAmountLimit("1000000000", 6)).not.toThrow();
  });
});
