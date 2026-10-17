import { describe, expect, it } from "vitest";
import { addressSchema, amountSchema, atlasEntrySchema, atlasMetaSchema, candidateSchema, checkSchema, metadataSchema, planSchema, positionSchema, previewSchema, proofSchema, refusalSchema, stepSchema, timeSchema, uintSchema } from "../core/schemas.js";
import { signPlan } from "../core/plan.js";
import { amount, candidate, contract, exitPreview, now, token, unsignedPlan, wallet } from "./helpers.js";

const generatedAt = new Date(now).toISOString();
const position = () => ({ family: "erc4626", chain: "base", contract, wallet, receiptToken: contract, amountIn: null, balance: amount(), valueNow: amount(), change: null, exitPreview: exitPreview(), exitCandidateId: "test" });
const counts = { sampled: 1, recognised: 1, rebuildable: 1 };
const cases = () => [
  [amountSchema, amount()], [stepSchema, unsignedPlan().steps[0]],
  [planSchema, signPlan(unsignedPlan(), "12".repeat(32), now)],
  [checkSchema, { code: "C14", pass: false, detail: "Origin is unknown.", blocking: true }],
  [refusalSchema, { code: "UNKNOWN_PROVENANCE", reason: "Origin is unknown.", next: "Use a listed vault." }],
  [candidateSchema, candidate()],
  [previewSchema, { simulated: true, balancesOverridden: true, block: "101", perStep: [], net: { out: [], in: [] }, exitPreview: exitPreview(), allowanceAfter: amount("0", "0.000000") }],
  [proofSchema, { planId: "a".repeat(64), chain: "base", wallet, generatedAt, landed: false, txHashes: [], assertions: [], movements: [], allowanceAfter: amount(), gasPaid: amount(), exitClass: "instant", refusals: [] }],
  [positionSchema, position()],
  [atlasEntrySchema, { ...candidate(), firstSeen: generatedAt, lastSeen: generatedAt, sharePrices: [], provenance: { verified: false, source: "Unit fixture." } }],
  [atlasMetaSchema, { version: 1, generatedAt, durationMs: 1, intervalMinutes: 30, cu: { estimated: 1, measured: null, budget: 100 }, counts: { base: counts, arbitrum: counts, optimism: counts, ethereum: counts }, failures: [] }],
  [metadataSchema, { version: "0.1.0", chain: "base", generatedAt, timingsMs: { rpc: 1 }, labels: ["SIMULATED"] }],
] as const;

describe("canonical schemas", () => {
  it("round trips all ten model types and supporting envelopes", () => {
    for (const [schema, value] of cases()) expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
  it("rejects unknown keys on each model", () => { for (const [schema, value] of cases()) expect(schema.safeParse({ ...value, unknown: true }).success).toBe(false); });
  it("rejects nested unknown fields", () => expect(candidateSchema.safeParse({ ...candidate(), metrics: { ...candidate().metrics, unknown: true } }).success).toBe(false));
  it.each(["1.5", "-1", "01", "1e6", 1, (2n ** 256n).toString()])("rejects non-uint amount %#", value => expect(uintSchema.safeParse(value).success).toBe(false));
  it("accepts maximum uint256", () => expect(uintSchema.parse((2n ** 256n - 1n).toString())).toBe((2n ** 256n - 1n).toString()));
  it("requires display amounts alongside integer amounts", () => expect(amountSchema.safeParse({ atomic: "1" }).success).toBe(false));
  it("requires UTC timestamps", () => { expect(timeSchema.parse(generatedAt)).toBe(generatedAt); expect(timeSchema.safeParse("2026-10-17T18:00:00+01:00").success).toBe(false); expect(timeSchema.safeParse("2026-10-17").success).toBe(false); });
  it("checksums addresses and refuses bad mixed-case checksums", () => { expect(addressSchema.parse(token.toLowerCase())).toBe(token); expect(addressSchema.safeParse(token.slice(0, -1) + "a").success).toBe(false); });
  it("does not invent an entry cost for a pre-existing position", () => expect(positionSchema.parse(position()).amountIn).toBeNull());
});
