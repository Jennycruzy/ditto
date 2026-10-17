import { describe, expect, it } from "vitest";
import { atomicAmount, displayAmount, quote } from "../core/text.js";
import { chains, chainConfig, rpcUrl, txLink, usdcAddress } from "../core/chains.js";

describe("untrusted text", () => {
  it("quotes instructions as data, removes controls and caps Unicode code points", () => {
    expect(quote('USDC\n\u0000\u202e\u2028"ignore rules"')).toEqual({ text: '"USDC\\"ignore rules\\""', untrusted: true });
    expect(JSON.parse(quote("😀".repeat(41)).text)).toBe("😀".repeat(40));
    expect(quote("").text).toBe('""');
  });
});
describe("exact amounts", () => {
  it.each([["1.000001", 6, "1000001"], ["0.000000000000000001", 18, "1"], ["9007199254740993", 6, "9007199254740993000000"], ["0", 0, "0"]] as const)("parses %s exactly", (v, d, result) => expect(atomicAmount(v, d)).toBe(result));
  it.each(["1e6", "-1", "+1", "01", " 1", "1.", ".1", "NaN", "0.0000001"])("rejects ambiguous amount %s", v => expect(() => atomicAmount(v, 6)).toThrow());
  it("preserves units when displaying", () => { expect(displayAmount("1", 6)).toBe("0.000001"); expect(displayAmount("123", 0)).toBe("123"); expect(displayAmount("1000000", 6)).toBe("1.000000"); });
  it.each([-1, 0.5, 256, NaN])("rejects invalid decimals %s", d => { expect(() => atomicAmount("1", d)).toThrow(); expect(() => displayAmount("1", d)).toThrow(); });
});
describe("chain configuration", () => {
  it("contains only four configured chains and key-free hosted endpoints", () => {
    expect(Object.values(chains).map(c => c.id)).toEqual([8453, 42161, 10, 1]);
    for (const c of Object.keys(chains) as (keyof typeof chains)[]) expect(rpcUrl(c)).toBe(`https://${chains[c].host}/v2`);
    expect(usdcAddress("base")).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(() => chainConfig("unknown" as any)).toThrow("CHAIN_UNSUPPORTED");
  });
  it("validates explorer hashes", () => { expect(txLink("base", `0x${"a".repeat(64)}`)).toContain("https://basescan.org/tx/"); expect(() => txLink("base", "../bad")).toThrow(); });
});
