import * as z from "zod/v4";
import { getAddress, isAddress } from "viem";

export const chainSchema = z.enum(["base", "arbitrum", "optimism", "ethereum"]);
export const familySchema = z.enum(["aave-v3", "erc4626", "compound-v3", "moonwell", "lst", "lp-v3"]);
export const addressSchema = z.string().refine(v => isAddress(v, { strict: true }), "Invalid address").transform(v => getAddress(v));
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const hexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
export const uintSchema = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine(v => v.length <= 78 && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 2n ** 256n, "Invalid uint256");
export const timeSchema = z.iso.datetime({ offset: false });
export const quotedSchema = z.object({ text: z.string().max(242), untrusted: z.literal(true) }).strict();
export const amountSchema = z.object({ atomic: uintSchema, display: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/) }).strict();
export const assetSchema = z.union([addressSchema, z.literal("native")]);
export const tokenAmountSchema = z.object({ token: assetSchema, amount: amountSchema }).strict();
export const exitClassSchema = z.enum(["instant", "queued", "market"]);
export const refusalCodes = ["UNRECOGNISED", "FAMILY_DISABLED", "ASSET_MISMATCH", "NOT_ENOUGH_USE", "TOO_NEW", "TOO_SMALL", "SHARE_PRICE_DROP", "EXIT_FAILS", "PAUSED", "CAP_REACHED", "FEE_ON_TRANSFER", "INSUFFICIENT_BALANCE", "INSUFFICIENT_GAS", "AMOUNT_OVER_LIMIT", "PLAN_TAMPERED", "PLAN_EXPIRED", "WALLET_MISMATCH", "CHAIN_UNSUPPORTED", "SIM_FAILED", "RPC_UNAVAILABLE", "EXIT_NOT_ACCEPTED", "UNKNOWN_PROVENANCE", "NOT_CONFIGURED", "WAIT_PENDING", "DUPLICATE_ENTER", "ALLOWANCE_LEFT", "SIGNER_MISMATCH", "NOT_BOUND", "SOURCE_DOWN", "SOURCE_TOO_EXPENSIVE", "SOURCE_NOT_COVERING", "SOURCE_FORMAT"] as const;
export const refusalSchema = z.object({ code: z.enum(refusalCodes), reason: z.string().min(1).max(500), next: z.string().min(1).max(500) }).strict();
export const checkSchema = z.object({ code: z.enum(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11", "C12", "C13", "C14"]), pass: z.boolean(), detail: z.string().max(500), blocking: z.boolean() }).strict();
export const expectationSchema = z.object({ kind: z.enum(["token-out", "token-in", "allowance", "position", "event", "owner", "return-code"]), token: assetSchema.optional(), account: addressSchema.optional(), spender: addressSchema.optional(), amount: amountSchema.optional(), minimum: amountSchema.optional(), event: z.string().max(128).optional() }).strict();
// ABI arguments use only JSON values: big integers travel as decimal strings.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().int().safe(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]));
export const stepSchema = z.object({ kind: z.enum(["bind", "approve-zero", "approve", "enter", "exit", "swap", "revoke", "claim"]), to: addressSchema, value: uintSchema, selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/), abiFragment: z.string().min(1).max(4096), args: z.array(jsonSchema).max(32), expect: z.array(expectationSchema).max(64) }).strict();
export const exitSchema = z.object({ kind: exitClassSchema, steps: z.array(stepSchema).max(16), detail: z.string().min(1).max(500) }).strict();
export const unsignedPlanSchema = z.object({
  v: z.literal(1), id: z.string().regex(/^[0-9a-f]{64}$/), chain: chainSchema, wallet: addressSchema,
  family: familySchema, contract: addressSchema, asset: assetSchema, amount: amountSchema, minReceive: amountSchema,
  exitClass: exitClassSchema, acceptExit: z.enum(["queued", "market"]).optional(),
  steps: z.array(stepSchema).min(1).max(16), exit: exitSchema,
  execution: z.object({ mode: z.enum(["enter", "exit", "revoke", "swap-back"]), receiptToken: addressSchema, assetDecimals: z.number().int().min(0).max(255), receiptDecimals: z.number().int().min(0).max(255), slippageBps: z.number().int().min(0).max(100), permissions: z.array(z.object({ token: addressSchema, spender: addressSchema, baseline: uintSchema }).strict()).max(8), tokenId: uintSchema.optional(), shares: uintSchema.optional(), halfWidthTicks: z.number().int().positive().optional(), lpMin0: uintSchema.optional(), lpMin1: uintSchema.optional(), expectedApprovals: z.number().int().nonnegative(), swapBack: z.boolean().optional(), parentPlanId: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict().optional(),
  baseline: z.object({ block: uintSchema, position: amountSchema, allowance: amountSchema, assetBalance: amountSchema }).strict(),
  createdAt: timeSchema, createdAtBlock: uintSchema, expiresAt: timeSchema,
}).strict();
export const planSchema = unsignedPlanSchema.extend({ sig: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const exitPreviewSchema = z.object({ simulated: z.literal(true), block: uintSchema, exitClass: exitClassSchema, returns: z.array(tokenAmountSchema), pass: z.boolean(), detail: z.string().max(500) }).strict();
export const stepPreviewSchema = z.object({ out: z.array(tokenAmountSchema), in: z.array(tokenAmountSchema), gasUsed: amountSchema }).strict();
export const previewSchema = z.object({ simulated: z.literal(true), balancesOverridden: z.boolean(), block: uintSchema, perStep: z.array(stepPreviewSchema), net: z.object({ out: z.array(tokenAmountSchema), in: z.array(tokenAmountSchema) }).strict(), exitPreview: exitPreviewSchema, allowanceAfter: amountSchema }).strict();
export const evidenceSchema = z.object({ window: z.enum(["1h", "24h", "7d"]), deposits: z.number().int().nonnegative(), uniqueWallets: z.number().int().nonnegative(), volumeAsset: amountSchema, lastSeenAgoSec: z.number().int().nonnegative(), sampleTxs: z.array(hashSchema).max(3) }).strict();
export const candidateSchema = z.object({
  id: z.string().min(1).max(256), family: familySchema, protocol: quotedSchema, contract: addressSchema, receiptToken: addressSchema, chain: chainSchema,
  evidence: evidenceSchema, metrics: z.object({ totalAssets: amountSchema, sharePriceChange7d: z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/).optional(), ageDays: z.number().nonnegative(), curator: quotedSchema.optional() }).strict(),
  checks: z.array(checkSchema), exitClass: exitClassSchema,
  forWallet: z.object({ simulated: z.literal(true), out: z.array(tokenAmountSchema), in: z.array(tokenAmountSchema), exitPreview: exitPreviewSchema, gasEstimate: amountSchema, verdict: z.enum(["ok", "refused"]), refusals: z.array(refusalSchema) }).strict().optional(),
  rank: z.object({ score: z.number().finite().nonnegative(), why: z.string().max(500) }).strict(),
}).strict();
export const proofSchema = z.object({ planId: z.string().regex(/^[0-9a-f]{64}$/), chain: chainSchema, wallet: addressSchema, generatedAt: timeSchema, landed: z.boolean(), txHashes: z.array(hashSchema), assertions: z.array(z.object({ code: z.string().max(128), pass: z.boolean(), detail: z.string().max(500) }).strict()), movements: z.array(tokenAmountSchema), allowanceAfter: amountSchema, gasPaid: amountSchema.nullable(), exitPreview: exitPreviewSchema.optional(), exitClass: exitClassSchema, refusals: z.array(refusalSchema) }).strict();
export const positionSchema = z.object({ family: familySchema, chain: chainSchema, contract: addressSchema, wallet: addressSchema, receiptToken: addressSchema, amountIn: amountSchema.nullable(), balance: amountSchema, valueNow: amountSchema, change: z.string().nullable(), exitPreview: exitPreviewSchema, exitCandidateId: z.string().max(256), tokenId: uintSchema.optional(), liquidity: amountSchema.optional(), owedFees: z.array(tokenAmountSchema).optional() }).strict();
export const atlasEntrySchema = candidateSchema.extend({ firstSeen: timeSchema, lastSeen: timeSchema, sharePrices: z.array(z.object({ at: timeSchema, value: amountSchema }).strict()).max(8), provenance: z.object({ verified: z.boolean(), source: z.string().max(500), factory: addressSchema.optional(), listed: z.boolean().optional() }).strict() }).strict();
export const atlasMetaSchema = z.object({ version: z.literal(1), generatedAt: timeSchema, durationMs: z.number().nonnegative(), intervalMinutes: z.number().int().min(30), cu: z.object({ estimated: z.number().nonnegative(), measured: z.number().nonnegative().nullable(), budget: z.number().positive() }).strict(), counts: z.record(chainSchema, z.object({ sampled: z.number().int().nonnegative(), recognised: z.number().int().nonnegative(), rebuildable: z.number().int().nonnegative() }).strict()), failures: z.array(z.object({ chain: chainSchema, reason: z.string().max(500) }).strict()) }).strict();
export const metadataSchema = z.object({ version: z.string().max(32), chain: chainSchema, generatedAt: timeSchema, timingsMs: z.record(z.string(), z.number().nonnegative()), labels: z.array(z.enum(["SIMULATED", "LIVE", "PARTIAL"])), incomplete: z.boolean().optional(), reason: z.string().max(500).optional() }).strict();

export type Plan = z.infer<typeof planSchema>;
export type UnsignedPlan = z.infer<typeof unsignedPlanSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Refusal = z.infer<typeof refusalSchema>;
export type Check = z.infer<typeof checkSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Preview = z.infer<typeof previewSchema>;
export type Proof = z.infer<typeof proofSchema>;
export type Position = z.infer<typeof positionSchema>;
export type AtlasEntry = z.infer<typeof atlasEntrySchema>;
export type AtlasMeta = z.infer<typeof atlasMetaSchema>;
