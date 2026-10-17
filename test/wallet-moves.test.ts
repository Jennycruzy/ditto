import { readFileSync } from "node:fs";
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
function history(options: { paged?: boolean; failReceipt?: boolean; irrelevant?: boolean; repeat?: boolean } = {}) {
  const pages: unknown[] = [], calls: string[] = [];
  const call = async (method: string, params: readonly any[]) => {
    calls.push(method);
    if (method === "eth_getBlockByNumber") {
      const number = params[0] === "latest" ? 100n : BigInt(params[0]);
      return { number: toHex(number), timestamp: toHex(epoch + number * 2000n) };
    }
    if (method === "alchemy_getAssetTransfers") {
      pages.push(params[0]);
      return { transfers: [options.irrelevant ? { ...row, hash: `0x${"12".repeat(32)}` } : row], ...(options.paged && (!params[0].pageKey || options.repeat) ? { pageKey: "next" } : {}) };
    }
    if (method === "eth_getTransactionByHash") { if (options.failReceipt) throw new Error("timeout"); return options.irrelevant ? { ...f.tx, hash: `0x${"12".repeat(32)}` } : f.tx; }
    if (method === "eth_getTransactionReceipt") return options.irrelevant ? { ...f.receipt, transactionHash: `0x${"12".repeat(32)}`, logs: [] } : f.receipt;
    if (method === "eth_call") {
      const records = JSON.parse(readFileSync(new URL("./fixtures/recognition/aave-base-direct.json", import.meta.url), "utf8")).rpc;
      const r = records.find((r: any) => r.method === method && JSON.stringify(r.params) === JSON.stringify(params.map(p => p === "0x64" ? originalBlock : p)));
      if (!r) throw new Error("unexpected read"); return r.result;
    }
    throw new Error("Unexpected method");
  };
  return { rpc: { call, batch: async inputs => Promise.all(inputs.map(c => call(c.method, c.params))) } as Rpc, pages, calls };
}
describe("bounded wallet history", () => {
  it("finds the exact first block at or after the time boundary", async () => {
    const h = history(); expect(await windowStart(h.rpc, "0x64", epoch + 50000n)).toBe("0x19");
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

describe("recorded test-wallet history", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/history/test-wallet-base.json", import.meta.url), "utf8"));
  it("reproduces the real enter and exit, without counting approvals as deposits", async () => {
    const lookup = (method: string, params: readonly unknown[]) => {
      const r = f.rpc.find((c: any) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!r) throw new Error("Missing recorded history call");
      if (r.error) throw new Error(r.error); return structuredClone(r.result);
    };
    const rpc = { call: async (method, params) => lookup(method, params), batch: async inputs => inputs.map(c => lookup(c.method, c.params)) } as Rpc;
    const result = await walletMoves(f.input, rpc, { now: Date.parse(f.generatedAt) });
    result.ditto.timingsMs = {}; const expected = structuredClone(f.expected); expected.ditto.timingsMs = {};
    expect(result).toEqual(expected);
    expect(result.moves.some(m => m.kind === "enter" && m.family === "aave-v3")).toBe(true);
    expect(result.moves.some(m => m.kind === "exit" && m.family === "aave-v3")).toBe(true);
    expect(result.moves.every(m => m.actor.toLowerCase() === f.input.wallet.toLowerCase())).toBe(true);
  });
});
