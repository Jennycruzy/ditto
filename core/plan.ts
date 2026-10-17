import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { planSchema, unsignedPlanSchema, type Plan, type UnsignedPlan, type Json } from "./schemas.js";
import { atomicAmount } from "./text.js";

export class PlanError extends Error {
  constructor(readonly code: "NOT_CONFIGURED" | "PLAN_TAMPERED" | "PLAN_EXPIRED" | "AMOUNT_OVER_LIMIT" | "EXIT_NOT_ACCEPTED" | "WALLET_MISMATCH") { super(code); }
}
export function canonicalJson(value: unknown): string {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 4096 || current.depth > 24) throw new Error("Canonical JSON exceeds limits");
    if (current.value && typeof current.value === "object") {
      if (Array.isArray(current.value) && Object.keys(current.value).length !== current.value.length) throw new Error("Canonical JSON requires dense arrays");
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  const seen = new Set<object>();
  function encode(v: unknown): string {
    if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number" && Number.isSafeInteger(v)) return JSON.stringify(v);
    if (typeof v !== "object" || v === null || seen.has(v)) throw new Error("Canonical JSON requires acyclic JSON values and safe integers");
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) result = `[${v.map(encode).join(",")}]`;
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error("Canonical JSON requires plain objects");
      result = `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode((v as Record<string, Json>)[k])}`).join(",")}}`;
    }
    seen.delete(v); return result;
  }
  return encode(value);
}
export function planHash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function keyBytes(key: string | undefined): Buffer {
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) throw new PlanError("NOT_CONFIGURED");
  return Buffer.from(key, "hex");
}
function signature(plan: UnsignedPlan, key: Buffer) { return createHmac("sha256", key).update(canonicalJson(plan)).digest("hex"); }
function constraints(plan: UnsignedPlan, now: number) {
  const created = Date.parse(plan.createdAt), expires = Date.parse(plan.expiresAt);
  if (created > now || expires <= now || expires <= created || expires - created > 30 * 60_000) throw new PlanError("PLAN_EXPIRED");
  if (plan.baseline.block !== plan.createdAtBlock || plan.exit.kind !== plan.exitClass) throw new PlanError("PLAN_TAMPERED");
  const expectedExit = plan.family === "lst" ? "queued" : plan.family === "lp-v3" ? "market" : "instant";
  if (plan.exitClass !== expectedExit) throw new PlanError("PLAN_TAMPERED");
  if (expectedExit !== "instant" && plan.acceptExit !== expectedExit) throw new PlanError("EXIT_NOT_ACCEPTED");
  if (expectedExit === "instant" && plan.acceptExit !== undefined) throw new PlanError("PLAN_TAMPERED");
}
// Only the checked planner calls this primitive; a valid MAC does not replace live checks or wallet binding.
export function signPlan(input: unknown, key: string | undefined, now = Date.now()): Plan {
  const bytes = keyBytes(key);
  try { canonicalJson(input); } catch { throw new PlanError("PLAN_TAMPERED"); }
  const parsed = unsignedPlanSchema.safeParse(input);
  if (!parsed.success) throw new PlanError("PLAN_TAMPERED");
  constraints(parsed.data, now);
  return { ...parsed.data, sig: signature(parsed.data, bytes) };
}
export function verifyPlan(input: unknown, key: string | undefined, now = Date.now()): Plan {
  const bytes = keyBytes(key);
  let original: string;
  try { original = canonicalJson(input); } catch { throw new PlanError("PLAN_TAMPERED"); }
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) throw new PlanError("PLAN_TAMPERED");
  const { sig, ...unsigned } = parsed.data;
  // Refuse even case-only field edits; every field is authenticated as issued.
  if (original !== canonicalJson(parsed.data) || !timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(signature(unsigned, bytes), "hex"))) throw new PlanError("PLAN_TAMPERED");
  constraints(unsigned, now); return parsed.data;
}
export function assertWallet(plan: Plan, wallet: string) {
  if (plan.wallet.toLowerCase() !== wallet.toLowerCase()) throw new PlanError("WALLET_MISMATCH");
}
export function assertAmountLimit(amount: string, decimals: number, maxAmount = "1000") {
  const maximum = BigInt(atomicAmount(maxAmount, decimals));
  if (!/^(0|[1-9][0-9]*)$/.test(amount) || BigInt(amount) === 0n || BigInt(amount) > maximum) throw new PlanError("AMOUNT_OVER_LIMIT");
}
