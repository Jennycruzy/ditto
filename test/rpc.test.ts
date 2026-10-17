import { describe, expect, it, vi } from "vitest";
import { JsonRpc, partialOnRpcFailure } from "../core/rpc.js";

const call = { method: "eth_blockNumber", params: [] };
function mock(handler: (payload: { id: number; method: string; params: unknown[] }[], attempt: number) => Response | Promise<Response>) {
  let attempt = 0;
  return vi.fn<typeof fetch>(async (_url, init) => handler(JSON.parse(String(init?.body)), attempt++));
}
function ok(payload: { id: number }[], result: unknown = "0x1") { return Response.json(payload.map(p => ({ jsonrpc: "2.0", id: p.id, result }))); }

describe("read-only JSON-RPC", () => {
  it("correlates shuffled response IDs and preserves null results", async () => {
    const fetch = mock(p => Response.json(p.map((x, i) => ({ jsonrpc: "2.0", id: x.id, result: i === 0 ? null : "0x2" })).reverse()));
    expect(await new JsonRpc("base", { fetch }).batch([call, call])).toEqual([null, "0x2"]);
    expect(fetch.mock.calls[0]![0]).toBe("https://base-mainnet.g.alchemy.com/v2");
    expect(fetch.mock.calls[0]![1]?.redirect).toBe("error");
  });
  it("retries once for a network failure, without returning provider text", async () => {
    const fetch = mock((p, n) => { if (n === 0) throw new Error("private-provider-string"); return ok(p); });
    expect(await new JsonRpc("base", { fetch }).call(call.method, [])).toBe("0x1"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([429, 500, 503])("retries HTTP %s once", async status => {
    const fetch = mock((p, n) => n === 0 ? new Response("private", { status }) : ok(p));
    expect(await new JsonRpc("base", { fetch }).call(call.method, [])).toBe("0x1"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("never retries an authentication error on the same provider, falls back once to the public RPC, and never echoes bodies", async () => {
    const urls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async url => { urls.push(String(url)); return new Response("private-provider-string", { status: 401 }); });
    const error = await new JsonRpc("base", { fetch }).call(call.method, []).catch(e => e as Error);
    expect(String(error)).toContain("RPC_UNAVAILABLE"); expect(String(error)).not.toContain("private-provider-string");
    expect(urls).toEqual(["https://base-mainnet.g.alchemy.com/v2", "https://mainnet.base.org"]);
  });
  it.each([
    (p: { id: number }[]) => [{ jsonrpc: "2.0", id: p[0]!.id + 1, result: "x" }],
    () => [], () => ({}),
    (p: { id: number }[]) => [{ jsonrpc: "1.0", id: p[0]!.id, result: "x" }],
    (p: { id: number }[]) => [{ jsonrpc: "2.0", id: p[0]!.id }],
    (p: { id: number }[]) => [{ jsonrpc: "2.0", id: p[0]!.id, result: "x", error: {} }],
  ])("rejects malformed response %# without retry", async response => {
    const fetch = mock(p => Response.json(response(p)));
    await expect(new JsonRpc("base", { fetch }).batch([call])).rejects.toThrow("invalid-response"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects duplicate IDs", async () => {
    const fetch = mock(p => Response.json([p[0], p[0]].map(x => ({ ...x, result: 1 }))));
    await expect(new JsonRpc("base", { fetch }).batch([call, call])).rejects.toThrow("invalid-response");
  });
  it("retries a transient RPC error only once", async () => {
    const fetch = mock(p => Response.json(p.map(x => ({ jsonrpc: "2.0", id: x.id, error: { code: -32005, message: "private" } }))));
    await expect(new JsonRpc("base", { fetch }).batch([call])).rejects.toThrow("rpc-error"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not retry a contract revert or invalid method", async () => {
    const fetch = mock(p => Response.json(p.map(x => ({ jsonrpc: "2.0", id: x.id, error: { code: 3, message: "private" } }))));
    await expect(new JsonRpc("base", { fetch }).call("eth_call", [])).rejects.toThrow("rpc-error"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("charges retry CU against the injected budget", async () => {
    const fetch = mock(() => new Response("", { status: 503 }));
    const rpc = new JsonRpc("base", { fetch, cost: () => 10, cuBudget: 15 });
    await expect(rpc.call(call.method, [])).rejects.toThrow("budget");
    expect(rpc.usage).toEqual({ requests: 1, calls: 1, estimatedCu: 10, cuMetered: true });
    expect(() => new JsonRpc("base", { cuBudget: 1 })).toThrow("requires a provider cost table");
  });
  it("bounds request count and batch count without fetching", async () => {
    const fetch = mock(p => ok(p)); const rpc = new JsonRpc("base", { fetch, maxRequests: 1, maxBatch: 1 });
    await expect(rpc.batch([])).rejects.toThrow("budget"); await expect(rpc.batch([call, call])).rejects.toThrow("budget");
    await rpc.batch([call]); await expect(rpc.batch([call])).rejects.toThrow("budget"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("never sends writes, signing requests, or arbitrary methods", async () => {
    const fetch = mock(p => ok(p));
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "personal_sign", "anything"]) await expect(new JsonRpc("base", { fetch }).call(method, [])).rejects.toThrow("unsupported-method");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honours a shared whole-call deadline and returns a partial result", async () => {
    let now = 0; const fetch = mock(p => { now = 7000; return ok(p); });
    const rpc = new JsonRpc("base", { fetch, now: () => now });
    const out = await partialOnRpcFailure(() => rpc.call(call.method, []));
    expect(out).toMatchObject({ incomplete: true, labels: ["PARTIAL"] }); expect(fetch).toHaveBeenCalledTimes(1);
    await expect(rpc.call(call.method, [])).rejects.toThrow("deadline"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves programming failures instead of hiding them as partial results", async () => {
    await expect(partialOnRpcFailure(async () => { throw new Error("bug"); })).rejects.toThrow("bug");
    expect(await partialOnRpcFailure(async () => 42)).toEqual({ incomplete: false, result: 42 });
  });
  it("aborts a fetch that never resolves", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    await expect(new JsonRpc("base", { fetch, timeoutMs: 10 }).call(call.method, [])).rejects.toThrow("unavailable"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rounds fractional remaining milliseconds for AbortSignal.timeout", async () => {
    const fetch = mock(p => ok(p));
    expect(await new JsonRpc("base", { fetch, deadlineMs: 123.75 }).call(call.method, [])).toBe("0x1");
  });
  it("aborts a response body that never finishes", async () => {
    const fetch = mock(() => new Response(new ReadableStream({ start() {} })));
    await expect(new JsonRpc("base", { fetch, timeoutMs: 10 }).call(call.method, [])).rejects.toThrow("unavailable");
  });
  it("rejects oversized streamed and declared responses", async () => {
    for (const response of [new Response("x".repeat(101)), new Response("x", { headers: { "content-length": "101" } })]) {
      const fetch = mock(() => response);
      await expect(new JsonRpc("base", { fetch, maxResponseBytes: 100 }).call(call.method, [])).rejects.toThrow("invalid-response");
    }
  });
  it("rejects invalid JSON without exposing it", async () => {
    const fetch = mock(() => new Response("private malformed json"));
    await expect(new JsonRpc("base", { fetch }).call(call.method, [])).rejects.toThrow("invalid-response"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["http://localhost", "https://user:password@example.com", "https://example.com/?key=value"])("rejects credential-bearing or insecure endpoint %s", endpoint => expect(() => new JsonRpc("base", { endpoint })).toThrow());
});
describe("public RPC fallback", () => {
  it("retries a throttled standard call once on the chain's public RPC without the brokered header", async () => {
    const seen: { url: string; auth: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
      if (url.includes("alchemy")) return new Response("", { status: 429 });
      return new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: "0x10" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const rpc = new JsonRpc("base", { fetch: fetcher, headers: { authorization: "Bearer test" } });
    expect(await rpc.call("eth_blockNumber", [])).toBe("0x10");
    expect(seen.map(s => s.url)).toEqual(["https://base-mainnet.g.alchemy.com/v2", "https://mainnet.base.org"]);
    expect(seen[1]!.auth).toBeUndefined();
  });
  it("never sends Alchemy-only methods to a public RPC", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => { urls.push(url); return new Response("", { status: 429 }); }) as unknown as typeof fetch;
    await expect(new JsonRpc("base", { fetch: fetcher }).call("alchemy_getAssetTransfers", [{}])).rejects.toThrow();
    expect(urls.every(u => u.includes("alchemy"))).toBe(true);
  });
});
describe("provider refusals", () => {
  it("falls back to the public RPC when Alchemy refuses the key, and reports the reason when it cannot", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => { urls.push(url); const id = JSON.parse(String(init.body))[0].id;
      return url.includes("alchemy") ? new Response(JSON.stringify([{ jsonrpc: "2.0", id, error: { code: -32600, message: "Must be authenticated!" } }]), { status: 200 }) : new Response(JSON.stringify([{ jsonrpc: "2.0", id, result: "0x2a" }]), { status: 200 }); }) as unknown as typeof fetch;
    expect(await new JsonRpc("base", { fetch: fetcher }).call("eth_blockNumber", [])).toBe("0x2a");
    expect(urls[1]).toBe("https://mainnet.base.org");
    await expect(new JsonRpc("base", { fetch: fetcher }).call("alchemy_getAssetTransfers", [{}])).rejects.toThrow("Must be authenticated");
  });
  it("does not fall back on a contract revert", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => { urls.push(url); const id = JSON.parse(String(init.body))[0].id; return new Response(JSON.stringify([{ jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } }]), { status: 200 }); }) as unknown as typeof fetch;
    await expect(new JsonRpc("base", { fetch: fetcher }).call("eth_call", [{}, "latest"])).rejects.toThrow("execution reverted");
    expect(urls.length).toBe(1);
  });
});
