import { rpcUrl, type Chain } from "./chains.js";

export interface RpcCall { method: string; params: readonly unknown[] }
export interface Rpc {
  call<T>(method: string, params: readonly unknown[]): Promise<T>;
  batch<T = unknown>(calls: readonly RpcCall[]): Promise<T[]>;
}
export class RpcError extends Error {
  readonly incomplete = true;
  constructor(readonly reason: "deadline" | "budget" | "unavailable" | "invalid-response" | "rpc-error" | "unsupported-method", readonly retryable = false) {
    super(`RPC_UNAVAILABLE: ${reason}. Try again; check the configured RPC host and Alchemy secret format if this persists.`);
  }
}
const methods = new Set(["eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getTransactionCount", "eth_getLogs", "eth_simulateV1", "alchemy_getAssetTransfers"]);
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new RpcError("unavailable", true);
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(new RpcError("unavailable", true));
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", listener); }
}
export interface RpcOptions {
  fetch?: typeof fetch;
  now?: () => number;
  deadlineMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxBatch?: number;
  // Costs are injected from the provider's published table, never guessed here.
  cost?: (method: string) => number;
  cuBudget?: number;
  maxRequests?: number;
  headers?: Readonly<Record<string, string>>;
  endpoint?: string;
}

export class JsonRpc implements Rpc {
  private nextId = 1;
  private readonly clock: () => number;
  private readonly fetcher: typeof fetch;
  readonly deadline: number;
  readonly usage = { requests: 0, calls: 0, estimatedCu: 0, cuMetered: false };
  constructor(readonly chain: Chain, private readonly options: RpcOptions = {}) {
    this.clock = options.now ?? (() => performance.now());
    this.fetcher = options.fetch ?? fetch;
    this.deadline = this.clock() + Math.min(6500, options.deadlineMs ?? 6500);
    this.usage.cuMetered = options.cost !== undefined;
    if (options.cuBudget !== undefined && !options.cost) throw new Error("CU budget requires a provider cost table");
    if (options.endpoint) {
      const endpoint = new URL(options.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid RPC endpoint");
    }
  }
  async call<T>(method: string, params: readonly unknown[]): Promise<T> {
    return (await this.batch<T>([{ method, params }]))[0] as T;
  }
  async batch<T = unknown>(calls: readonly RpcCall[]): Promise<T[]> {
    if (calls.length < 1 || calls.length > (this.options.maxBatch ?? 64)) throw new RpcError("budget");
    if (calls.some(c => !methods.has(c.method))) throw new RpcError("unsupported-method");
    const payload = calls.map(c => ({ jsonrpc: "2.0", id: this.nextId++, method: c.method, params: c.params }));
    const cost = calls.reduce((sum, c) => {
      const n = this.options.cost?.(c.method) ?? 0;
      if (!Number.isFinite(n) || n < 0) throw new RpcError("budget");
      return sum + n;
    }, 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = this.deadline - this.clock();
      if (remaining <= 0) throw new RpcError("deadline");
      if (this.usage.requests >= (this.options.maxRequests ?? 8) || this.usage.estimatedCu + cost > (this.options.cuBudget ?? Infinity)) throw new RpcError("budget");
      this.usage.requests++; this.usage.calls += calls.length; this.usage.estimatedCu += cost;
      const timeout = Math.max(1, Math.floor(Math.min(3500, this.options.timeoutMs ?? 3500, remaining)));
      const signal = AbortSignal.timeout(timeout);
      try {
        const response = await bounded(this.fetcher(this.options.endpoint ?? rpcUrl(this.chain), {
          method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...this.options.headers },
          body: JSON.stringify(payload), signal,
        }), signal);
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new RpcError("unavailable", response.status === 429 || response.status >= 500);
        }
        const limit = this.options.maxResponseBytes ?? 1_048_576;
        if (Number(response.headers.get("content-length")) > limit) {
          void response.body?.cancel().catch(() => {}); throw new RpcError("invalid-response");
        }
        if (!response.body) throw new RpcError("invalid-response");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const part = await bounded(reader.read(), signal);
            if (part.done) break;
            size += part.value.byteLength;
            if (size > limit) { void reader.cancel().catch(() => {}); throw new RpcError("invalid-response"); }
            chunks.push(part.value);
          }
        } finally { if (signal.aborted) void reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (signal.aborted) throw new RpcError("unavailable", true);
        if (this.clock() >= this.deadline) throw new RpcError("deadline");
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let body: unknown;
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new RpcError("invalid-response"); }
        if (!Array.isArray(body) || body.length !== payload.length) throw new RpcError("invalid-response");
        const byId = new Map<number, Record<string, unknown>>();
        for (const item of body) {
          if (!item || typeof item !== "object" || item.jsonrpc !== "2.0" || typeof item.id !== "number" || !payload.some(p => p.id === item.id) || byId.has(item.id)) throw new RpcError("invalid-response");
          byId.set(item.id, item);
        }
        return payload.map(p => {
          const item = byId.get(p.id);
          if (!item || Object.hasOwn(item, "error") === Object.hasOwn(item, "result")) throw new RpcError("invalid-response");
          if (Object.hasOwn(item, "error")) {
            const error = item.error as { code?: number } | null;
            throw new RpcError("rpc-error", error?.code === -32005 || error?.code === -32016 || error?.code === -32603);
          }
          return item.result as T;
        });
      } catch (error) {
        const failure = error instanceof RpcError ? error : new RpcError("unavailable", true);
        if (this.clock() >= this.deadline) throw new RpcError("deadline");
        if (attempt === 1 || !failure.retryable) throw failure;
      }
    }
    throw new RpcError("unavailable");
  }
}

export async function partialOnRpcFailure<T>(work: () => Promise<T>): Promise<{ incomplete: false; result: T } | { incomplete: true; reason: string; labels: ["PARTIAL"] }> {
  try { return { incomplete: false, result: await work() }; }
  catch (error) {
    if (!(error instanceof RpcError)) throw error;
    return { incomplete: true, reason: error.message, labels: ["PARTIAL"] };
  }
}
