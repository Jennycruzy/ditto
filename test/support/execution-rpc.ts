import { readFileSync } from "node:fs";
import { decodeAbiParameters, encodeAbiParameters, encodeEventTopics, parseAbi, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import type { Rpc, RpcCall } from "../../core/rpc.js";
import type { Evidence } from "../../core/execution/types.js";
import type { Plan } from "../../core/schemas.js";
import { encodeStep } from "../../core/encoding.js";
import { ZERO } from "../../core/recipes/shared.js";
export const key = "11".repeat(32); // Public unit-test key; never a deployment key.
export class ExecutionRpc implements Rpc {
  fixture: any;
  constructor(name = "aave-base") { this.fixture = JSON.parse(readFileSync(new URL(`../fixtures/recipes/${name}.json`, import.meta.url), "utf8")); this.reset(); }
  reset() { this.now = Date.parse(this.fixture.generatedAt); this.block = BigInt(this.fixture.block); this.wallet = this.fixture.wallet; this.asset = this.fixture.identity.asset; this.pool = this.fixture.identity.contract; this.receiptToken = this.fixture.identity.receiptToken; }
  now = 0; block = 0n; wallet = ZERO as Address; asset = ZERO as Address; pool = ZERO as Address; receiptToken = ZERO as Address;
  assetBalance = 100_000_000n; position = 0n; allowance = 0n; eth = 10n ** 16n;
  paused = false; unknown = false; cap = false; feeToken = false; zeroFirst = false; exitFails = false; wrongNft = false; outage = false;
  calls: RpcCall[] = []; transactions = new Map<string, { tx: any; receipt: any }>(); pages = 1;
  evidence(): Evidence { return { chain: "base", contract: this.pool, generatedAt: new Date(this.now).toISOString(), deposits24h: 10, uniqueWallets24h: 5, firstSeen: new Date(this.now - 365 * 86400000).toISOString(), sharePrices: Array.from({ length: 8 }, (_, n) => ({ at: new Date(this.now - (7 - n) * 86400000).toISOString(), value: (10n ** 27n).toString() })), lpRanges: [], volume24hUsd: "100000000", incomplete: false }; }
  records() { return this.fixture.rpc as any[]; }
  word(n: bigint) { return toHex(n, { size: 32 }); }
  async batch<T>(calls: readonly RpcCall[]): Promise<T[]> { return Promise.all(calls.map(c => this.call<T>(c.method, c.params))); }
  async call<T>(method: string, params: readonly any[]): Promise<T> {
    this.calls.push({ method, params }); if (this.outage) throw new Error("RPC_UNAVAILABLE: deadline");
    if (method === "eth_blockNumber") return toHex(this.block) as T;
    if (method === "eth_getBalance") return toHex(this.eth) as T;
    if (method === "eth_gasPrice") return "0xa" as T;
    if (method === "eth_estimateGas") return "0x186a0" as T;
    if (method === "eth_getTransactionByHash") return (this.transactions.get(params[0])?.tx ?? null) as T;
    if (method === "eth_getTransactionReceipt") return (this.transactions.get(params[0])?.receipt ?? null) as T;
    if (method === "eth_getLogs") return [...this.transactions.values()].flatMap(t => (t.receipt?.logs ?? []).filter((l: any) => l.topics[0]?.startsWith("0x8c5be1e5")).map((l: any) => ({ ...l, transactionHash: t.tx.hash }))) as T;
    if (method === "alchemy_getAssetTransfers") {
      const page = params[0].pageKey ? Number(params[0].pageKey) : 0;
      return { transfers: [...this.transactions.keys()].map(hash => ({ hash })), ...(page + 1 < this.pages ? { pageKey: String(page + 1) } : {}) } as T;
    }
    if (method === "eth_simulateV1") {
      const inputs = params[0].blockStateCalls[0].calls;
      return [{ number: toHex(this.block + 1n), calls: inputs.map((c: any, n: number) => this.simCall(c, n)) }] as T;
    }
    if (method === "eth_call") {
      const c = params[0], data = c.data as string, to = c.to.toLowerCase();
      if (data.startsWith("0x70a08231") && data.slice(-40).toLowerCase() === this.wallet.slice(2).toLowerCase()) return this.word(to === this.asset.toLowerCase() ? this.assetBalance : this.position) as T;
      if (data.startsWith("0xdd62ed3e")) return this.word(this.allowance) as T;
      if (data.slice(0, 10) === toFunctionSelector("getPriceOracle()")) return encodeAbiParameters([{ type: "address" }], [this.pool]) as T;
      if (data.slice(0, 10) === toFunctionSelector("BASE_CURRENCY()")) return encodeAbiParameters([{ type: "address" }], [ZERO]) as T;
      if (data.slice(0, 10) === toFunctionSelector("BASE_CURRENCY_UNIT()")) return this.word(100_000_000n) as T;
      if (data.slice(0, 10) === toFunctionSelector("getAssetPrice(address)")) return this.word(2000n * 100_000_000n) as T;
      const recorded = this.records().find(r => r.method === method && r.params[0].to.toLowerCase() === to && r.params[0].data.toLowerCase() === data.toLowerCase());
      if (!recorded) throw new Error(`Unit RPC has no getter ${data.slice(0, 10)}`);
      let result = recorded.result;
      if (data.slice(0, 10) === toFunctionSelector("getPool()") && this.unknown) result = encodeAbiParameters([{ type: "address" }], [this.wallet]);
      if (data.slice(0, 10) === toFunctionSelector("getReserveData(address)")) {
        let flags = BigInt(`0x${result.slice(2, 66)}`); if (this.paused) flags |= 1n << 60n; if (this.cap) flags = (flags & ~(((1n << 36n) - 1n) << 116n)) | (1n << 116n); // supply cap = 1 whole token, far below total supplied
        result = this.word(flags) + result.slice(66);
      }
      return result as T;
    }
    throw new Error(`Unsupported unit method ${method}`);
  }
  simCall(c: any, index = 0) {
    if (c.data.startsWith("0xd1770000")) return { status: "0x1", returnData: "0x", gasUsed: "0x5400", logs: [] };
    if ((this.zeroFirst && c.data.startsWith("0x095ea7b3") && this.allowance > 0n && BigInt(`0x${c.data.slice(-64)}`) > 0n && index === 0) || (this.exitFails && c.data.startsWith("0x69328dec"))) return { status: "0x0", returnData: "0x", gasUsed: "0x100", logs: [], error: { code: 3, message: "Unit simulation revert" } };
    for (const row of this.records().filter(r => r.method === "eth_simulateV1")) {
      const calls = row.params[0].blockStateCalls[0].calls;
      const n = calls.findIndex((x: any) => x.to.toLowerCase() === c.to.toLowerCase() && x.data.toLowerCase() === c.data.toLowerCase());
      if (n < 0) continue;
      const result = structuredClone(row.result[0].calls[n]);
      if (this.feeToken && c.to.toLowerCase() === this.pool.toLowerCase() && c.data.startsWith("0x617ba037")) {
        for (const l of result.logs) if (l.address.toLowerCase() === this.receiptToken.toLowerCase() && l.topics[0].startsWith("0xddf252ad")) l.data = this.word(999997n);
      }
      return result;
    }
    if (c.data.startsWith("0x095ea7b3")) return { status: "0x1", returnData: this.word(1n), gasUsed: "0x8000", logs: this.approvalLogs(c.data) };
    if (c.data.startsWith("0xdd62ed3e")) return { status: "0x1", returnData: this.word(0n), gasUsed: "0x1000", logs: [] };
    if (c.data.slice(0, 10) === toFunctionSelector("getReserveNormalizedIncome(address)")) return { status: "0x1", returnData: this.word(BigInt(this.fixture.checkedIdentity.details.normalizedIncome)), gasUsed: "0x1000", logs: [] };
    if (c.data.startsWith("0x69328dec")) {
      const row = this.records().filter(r => r.method === "eth_simulateV1").at(-1), calls = row.params[0].blockStateCalls[0].calls, n = calls.findIndex((x: any) => x.data.startsWith("0x69328dec"));
      return structuredClone(row.result[0].calls[n]);
    }
    throw new Error(`Unit simulation has no call ${c.data.slice(0, 10)}`);
  }
  approvalLogs(data: Hex) {
    const [spender, amount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], `0x${data.slice(10)}`);
    return [{ address: this.asset, topics: encodeEventTopics({ abi: parseAbi(["event Approval(address indexed owner,address indexed spender,uint256 value)"]), eventName: "Approval", args: { owner: this.wallet, spender } }), data: this.word(amount) }];
  }
  confirm(p: Plan, index: number, options: { signer?: Address; pending?: boolean; hash?: Hex } = {}) {
    const step = p.steps[index]!, encoded = encodeStep(step), hash = options.hash ?? `0x${(this.transactions.size + 1).toString(16).padStart(64, "0")}` as Hex;
    const block = ++this.block, signer = options.signer ?? this.wallet, blockHash = `0x${"ab".repeat(32)}` as Hex;
    const sim = this.simCall({ ...encoded, from: signer }, 1);
    const tx = { hash, from: signer, to: encoded.to, input: encoded.data, value: toHex(BigInt(encoded.value)), blockNumber: options.pending ? null : toHex(block), blockHash: options.pending ? null : blockHash };
    const receipt = options.pending ? null : { transactionHash: hash, from: signer, to: encoded.to, blockNumber: toHex(block), blockHash, transactionIndex: "0x0", status: "0x1", logs: sim.logs, gasUsed: sim.gasUsed, effectiveGasPrice: "0xa", l1Fee: "0x1" };
    this.transactions.set(hash, { tx, receipt });
    if (!options.pending && !options.signer) { if (step.kind === "approve" || step.kind === "approve-zero" || step.kind === "revoke") this.allowance = BigInt(String(step.args[1])); if (step.kind === "enter") { this.allowance = 0n; this.position += 999999n; this.assetBalance -= BigInt(p.amount.atomic); } }
    return hash;
  }
}
