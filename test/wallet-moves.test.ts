import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toHex } from "viem";
import { walletMoves, windowStart } from "../core/recognise/wallet.js";
import { parseMorphoListing, morphoListing } from "../core/morpho.js";
import { wallet, other } from "./helpers.js";
import type { Rpc } from "../core/rpc.js";
const f = JSON.parse(readFileSync(new URL("./fixtures/receipts/aave-base-direct.json", import.meta.url), "utf8"));
const originalBlock = f.receipt.blockNumber; f.tx.blockNumber = "0x64"; f.receipt.blockNumber = "0x64";
const now = Date.parse("2026-10-17T20:00:00Z"), epoch = BigInt(now / 1000) - 200000n;
const row = { hash: f.tx.hash, blockNum: "0x64", from: f.tx.from, to: f.expected[0].actor };
function history(options: { paged?: boolean; failReceipt?: boolean; irrelevant?: boolean; repeat?: boolean; twoTx?: boolean } = {}) {
  const pages: unknown[] = [], calls: string[] = [];
  let active = 0, maxActive = 0;
  const call = async (method: string, params: readonly any[]) => {
    calls.push(method);
    if (method === "eth_getBlockByNumber") {
      const number = params[0] === "latest" ? 100n : BigInt(params[0]);
      return { number: toHex(number), timestamp: toHex(epoch + number * 2000n) };
    }
    if (method === "alchemy_getAssetTransfers") {
      pages.push(params[0]);
      return { transfers: [options.irrelevant ? { ...row, hash: `0x${"12".repeat(32)}` } : row, ...(options.twoTx ? [{ ...row, hash: `0x${"34".repeat(32)}` }] : [])], ...(options.paged && (!params[0].pageKey || options.repeat) ? { pageKey: "next" } : {}) };
    }
    if (method === "eth_getTransactionByHash") { if (options.failReceipt) throw new Error("timeout"); active++; maxActive = Math.max(active, maxActive); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { ...f.tx, hash: params[0] }; }
    if (method === "eth_getTransactionReceipt") return { ...f.receipt, transactionHash: params[0], ...(options.irrelevant ? { logs: [] } : {}) };
    if (method === "eth_call") {
      const records = JSON.parse(readFileSync(new URL("./fixtures/recognition/aave-base-direct.json", import.meta.url), "utf8")).rpc;
      const r = records.find((r: any) => r.method === method && JSON.stringify(r.params) === JSON.stringify(params.map(p => p === "0x64" ? originalBlock : p)));
      if (!r) throw new Error("unexpected read"); return r.result;
    }
    throw new Error("Unexpected method");
  };
  return { rpc: { call, batch: async inputs => Promise.all(inputs.map(c => call(c.method, c.params))) } as Rpc, pages, calls, maxActive: () => maxActive };
}
describe("bounded wallet history", () => {
  it("uses at most four timestamp reads to find the seeded boundary", async () => {
    const h = history(); expect(await windowStart(h.rpc, "0x64", epoch + 50000n)).toBe("0x19"); expect(h.calls.filter(c => c === "eth_getBlockByNumber").length).toBeLessThanOrEqual(4);
  });
  it("scans both directions, deduplicates hashes, and credits the event actor", async () => {
    const h = history(), actor = f.expected[0].actor;
    const result = await walletMoves({ chain: "base", wallet: actor, limit: 5 }, h.rpc, { now });
    expect(result.scannedTransactions).toBe(1); expect(result.pages).toBe(2); expect(result.ditto.incomplete).toBe(false);
    expect(result.moves).toHaveLength(1); expect(result.moves[0]!.actor).toBe(actor); expect(result.moves[0]!.candidateId).toContain("aave-v3"); expect(result.moves[0]!.time).toBe(new Date(now).toISOString());
    expect(h.pages.some((p: any) => p.fromAddress === actor)).toBe(true); expect(h.pages.some((p: any) => p.toAddress === actor)).toBe(true);
  });
  it("follows pages when the transaction limit is not met", async () => {
    const h = history({ paged: true });
    const result = await walletMoves({ chain: "base", wallet: f.expected[0].actor, limit: 5 }, h.rpc, { now });
    expect(result.pages).toBe(4); expect(result.scannedTransactions).toBe(1); expect(result.ditto.incomplete).toBe(false);
  });
  it("marks an unfinished page scan partial and stops repeated page keys", async () => {
    const h = history({ paged: true, repeat: true });
    const result = await walletMoves({ chain: "base", wallet: f.expected[0].actor, limit: 5 }, h.rpc, { now, maxPages: 12 });
    expect(result.pages).toBe(4); expect(result.ditto.labels).toContain("PARTIAL");
  });
  it("marks hitting a page or transaction budget partial", async () => {
    const h = history({ paged: true });
    const result = await walletMoves({ chain: "base", wallet: f.expected[0].actor, limit: 1 }, h.rpc, { now, maxPages: 1 });
    expect(result.ditto.incomplete).toBe(true); expect(result.text).toContain("not the wallet's complete history");
  });
  it("does not turn a failed receipt read into no wallet activity", async () => {
    const h = history({ failReceipt: true });
    const r = await walletMoves({ chain: "base", wallet: f.expected[0].actor }, h.rpc, { now });
    expect(r.ditto.incomplete).toBe(true); expect(r.notRecognised.count).toBe(1); expect(r.notRecognised.reasons[0]!.reason).toContain("RPC_UNAVAILABLE");
  });
  it("returns unknown bounds and partial status when the initial RPC fails", async () => {
    const rpc = { call: async () => { throw new Error("timeout"); } } as unknown as Rpc;
    const r = await walletMoves({ chain: "base", wallet }, rpc, { now }); expect(r.fromBlock).toBeNull(); expect(r.toBlock).toBeNull(); expect(r.ditto.labels).toContain("PARTIAL"); expect(r.text).toContain("does not mean");
  });
  it("counts unrecognised receipts with reasons", async () => {
    const h = history({ irrelevant: true });
    const r = await walletMoves({ chain: "base", wallet: f.expected[0].actor }, h.rpc, { now });
    expect(r.moves).toHaveLength(0); expect(r.notRecognised.count).toBe(1); expect(r.notRecognised.reasons[0]!.reason).toContain("UNRECOGNISED");
  });
});
describe("Morpho warnings as untrusted data", () => {
  const v = { address: wallet, listed: true, totalAssetsUsd: 1000000, warnings: [{ type: "test warning", level: "RED" }] };
  it("keeps real warning fields and rejects a different contract", () => {
    expect(parseMorphoListing({ data: { v2: v } }, wallet, "base", now)?.warnings).toEqual(["RED: test warning"]);
    expect(() => parseMorphoListing({ data: { v2: v } }, other, "base", now)).toThrow("Wrong vault");
  });
  it("queries versions separately because a missing non-null GraphQL field nulls the response", async () => {
    const queries: string[] = [];
    const fetcher = (async (_url, init) => { const query = JSON.parse(String(init?.body)).query; queries.push(query); return Response.json(queries.length === 1 ? { data: null, errors: [{ message: "Not found" }] } : { data: { v1: { ...v, state: { totalAssetsUsd: 1000000 } } } }); }) as typeof fetch;
    const r = await morphoListing(wallet, "base", fetcher, now);
    expect(queries).toHaveLength(2); expect(queries[0]).not.toContain("vaultByAddress"); expect(queries[1]).not.toContain("vaultV2ByAddress"); expect(r?.listed).toBe(true);
  });
});

describe("recorded wallet histories", () => {
  const dir = new URL("./fixtures/history/", import.meta.url);
  for (const name of readdirSync(dir)) {
    const f = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    it(`${name}: reproduces real supported activity with the bounded parallel scan`, async () => {
      const lookup = (method: string, params: readonly unknown[]) => {
        const r = f.rpc.find((c: any) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
        if (!r) throw new Error("Missing recorded history call");
        if (r.error) throw new Error(r.error); return structuredClone(r.result);
      };
      const rpc = { call: async (method, params) => lookup(method, params), batch: async inputs => inputs.map(c => lookup(c.method, c.params)) } as Rpc;
      const result = await walletMoves(f.input, rpc, { now: Date.parse(f.generatedAt) });
      result.ditto.timingsMs = {}; const expected = structuredClone(f.expected); expected.ditto.timingsMs = {};
      expect(result).toEqual(expected);
      expect(result.moves.some(m => m.family === "aave-v3")).toBe(true);
      if (f.input.chain === "base") {
        expect(result.moves.some(m => m.kind === "enter")).toBe(true);
        expect(result.moves.some(m => m.kind === "exit")).toBe(true);
      }
      expect(result.moves.every(m => m.actor.toLowerCase() === f.input.wallet.toLowerCase())).toBe(true);
      expect(f.rpc.filter((c: any) => c.method === "eth_getBlockByNumber").length).toBeLessThanOrEqual(4);
      if (f.input.chain === "arbitrum") for (const c of f.rpc.filter((c: any) => c.method === "alchemy_getAssetTransfers")) expect(c.params[0].category).not.toContain("internal");
    });
  }
});


describe("history concurrency and network categories", () => {
  it("runs independent transaction explanations concurrently and reuses getters", async () => {
    const h = history({ twoTx: true });
    const r = await walletMoves({ chain: "base", wallet: f.expected[0].actor, limit: 5 }, h.rpc, { now });
    expect(r.moves).toHaveLength(2); expect(h.maxActive()).toBe(2);
    expect(h.calls.filter(c => c === "eth_call").length).toBe(7);
  });
  it.each(["base", "arbitrum", "optimism", "ethereum"])("%s includes internal transfers only on Ethereum", async chain => {
    const h = history(); await walletMoves({ chain, wallet: f.expected[0].actor }, h.rpc, { now });
    expect(h.pages.length).toBe(2);
    for (const page of h.pages as { category: string[] }[]) expect(page.category.includes("internal")).toBe(chain === "ethereum");
  });
});
