import * as z from "zod/v4";
import type { Address, Hex } from "viem";
import { addressSchema, chainSchema, familySchema } from "../schemas.js";
import { adaptOpinion, chooseSource, compareOpinion, dittoNumbers, HARD_MAX_PRICE, probeSource, sources, usd, type SourceId } from "../opinions.js";
import { atomicAmount } from "../text.js";
import type { ExecutionEngine } from "./engine.js";
import { codeOf } from "./engine.js";
import { refusalFrom } from "./types.js";
import { familyWords, chainWords, short } from "./words.js";
const target = { chain: chainSchema, family: familySchema, contract: addressSchema };
const sourceId = z.enum(["mi-usdc", "pulse-vaults", "otto-markets", "otto-recs"]);
export const secondOpinionInputSchema = z.object({ ...target, source: z.union([z.literal("auto"), sourceId]).default("auto"), maxUsd: z.string().regex(/^0(\.[0-9]{1,6})?$/).default("0.05") }).strict();
export const compareInputSchema = z.object({ ...target, source: sourceId, response: z.unknown(), requestId: z.string().max(128).optional() }).strict();
const placeholder = "0x000000000000000000000000000000000000d177" as Address;
// ditto_second_opinion: probe unpaid, then hand PayBox an x402 request it pays only after the user's approval.
export async function secondOpinion(engine: ExecutionEngine, input: unknown, fetcher: typeof fetch = fetch) {
  try {
    const a = secondOpinionInputSchema.parse(input), block = await engine.rpc.call<Hex>("eth_blockNumber", []);
    const i = await engine.identity(a, placeholder, block), source = chooseSource(a.chain, i.family, i.contract, a.source);
    const limit = BigInt(atomicAmount(a.maxUsd, 6)), cap = limit < HARD_MAX_PRICE ? limit : HARD_MAX_PRICE;
    const live = await probeSource(source, fetcher).catch(e => { throw new Error(String((e as Error).message).startsWith("SOURCE_") ? (e as Error).message : "SOURCE_DOWN: the source did not answer in time"); });
    if (live.amount > cap) throw new Error(`SOURCE_TOO_EXPENSIVE: asks ${usd(live.amount)} USDC, limit ${usd(cap)} USDC`);
    const where = `${familyWords[i.family]} (${short(i.contract)}) on ${chainWords[i.chain]}`;
    return { verdict: "ok" as const, x402: { chain: "eip155:8453" as const, url: source.url, maxAmount: live.amount.toString(), method: "GET" as const }, source: { id: source.id, name: source.name, priceUsd: usd(live.amount), x402Version: source.version }, refusals: [],
      text: `Paying ${usd(live.amount)} USDC to ${source.name} for an independent read of ${where}. PayBox will ask you to approve. When it's done, pass the paid response body to ditto_compare_opinion with source "${source.id}". Poll the PayBox request ID to the end; do not run this tool again to finish the payment.` };
  } catch (error) { const r = refusalFrom(codeOf(error), error); return { verdict: "refused" as const, refusals: [r], text: `${r.reason} ${r.next}` }; }
}
// ditto_compare_opinion: validate the paid body with the source's adapter, then compare with Ditto's own chain reads.
export async function compareSecondOpinion(engine: ExecutionEngine, input: unknown) {
  try {
    const a = compareInputSchema.parse(input), block = await engine.rpc.call<Hex>("eth_blockNumber", []);
    const source = sources.find(s => s.id === a.source)!;
    if (!source.enabled) throw new Error(`SOURCE_DOWN: ${source.disabledReason}`);
    const i = await engine.identity(a, placeholder, block);
    let body = a.response; if (typeof body === "string") { try { body = JSON.parse(body); } catch { throw new Error("SOURCE_FORMAT: the response is not JSON"); } }
    const row = adaptOpinion(source.id as SourceId, body, i), ditto = await dittoNumbers(i, engine.rpc, block), c = compareOpinion(row, ditto);
    const where = `${familyWords[i.family]} (${short(i.contract)}) on ${chainWords[i.chain]}`;
    const size = (n: number | null) => n === null ? "no size" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString("en-US")}`;
    const text = !row ? `${source.name} does not list ${where}. Not listed is not agreement; Ditto's own checks still apply.`
      : `Independent source (paid ${usd(source.price)} USDC, ${source.name}) says ${row.apyPct.toFixed(2)}% APY and ${size(row.sizeUsd)}; Ditto reads ${ditto.apyPct.toFixed(2)}% (${ditto.method}) and ${size(ditto.sizeUsd)} onchain at block ${BigInt(block)}. ${c.verdict === "agrees" ? "They agree." : `They disagree${c.apyAgrees === false ? " on APY" : ""}${c.sizeAgrees === false ? " on size" : ""}. This is shown next to the plan as check C15 and does not block it by itself.`}`;
    return { verdict: c.verdict, rows: row ? [{ ...row, untrusted: true }] : [], ditto: { ...ditto, block: BigInt(block).toString() }, agreement: { apy: c.apyAgrees, size: c.sizeAgrees }, paid: { source: source.id, priceUsd: usd(source.price), ...(a.requestId ? { requestId: a.requestId } : {}) }, check: { code: "C15", pass: c.verdict === "agrees", blocking: false, detail: text }, refusals: [], text };
  } catch (error) { const r = refusalFrom(codeOf(error), error); return { verdict: "refused" as const, refusals: [r], text: `${r.reason} ${r.next}` }; }
}
