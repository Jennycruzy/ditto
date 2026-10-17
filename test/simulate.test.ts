import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { dryRunOverrides, ETH_TRACE_ADDRESS, mappingSlot, parseTokenTransfers, simulate, walletDeltas } from "../core/simulate.js";
import type { Rpc } from "../core/rpc.js";
import { other, token, topic, transfer, wallet } from "./helpers.js";

function result(logs = [transfer()]) { return [{ number: "0x65", calls: [{ status: "0x1", gasUsed: "0x5208", returnData: "0x", logs }] }]; }
function rpcFor(value: unknown) {
  return { call: vi.fn(async () => value), batch: vi.fn() } as unknown as Rpc;
}
const call = { from: wallet, to: token, data: "0x" };
describe("simulation transfers", () => {
  it("reads exact ERC20 transfers with values above JS integer precision", () => {
    expect(parseTokenTransfers([transfer(9007199254740993n)])).toEqual([{ kind: "erc20", token, from: wallet, to: other, amount: "9007199254740993" }]);
  });
  it("separates ERC721 token IDs from fungible amounts", () => {
    const log = { ...transfer(), topics: [...transfer().topics, toHex(42n, { size: 32 })], data: "0x" };
    expect(parseTokenTransfers([log])).toEqual([{ kind: "erc721", token, from: wallet, to: other, amount: "1", tokenId: "42" }]);
  });
  it("recognises native trace logs only in simulation context", () => {
    const log = { ...transfer(), address: ETH_TRACE_ADDRESS };
    expect(parseTokenTransfers([log], true)[0]).toMatchObject({ token: "native", kind: "native" });
    expect(parseTokenTransfers([log])[0]?.kind).toBe("erc20");
  });
  it("ignores unrelated logs and rejects removed logs", () => {
    expect(parseTokenTransfers([{ ...transfer(), topics: [] }])).toEqual([]);
    expect(() => parseTokenTransfers([{ ...transfer(), removed: true }])).toThrow("invalid-result");
  });
  it.each([
    { ...transfer(), data: "0x" }, { ...transfer(), data: "0x01" },
    { ...transfer(), topics: [transfer().topics[0]!] },
    { ...transfer(), topics: [transfer().topics[0]!, `0x${"1".repeat(64)}`, topic(other)] },
    { ...transfer(), topics: [...transfer().topics, toHex(1n, { size: 32 })] },
  ])("rejects malformed Transfer logs %#", log => expect(() => parseTokenTransfers([log])).toThrow());
  it("nets self-transfers, mints, burns and receipts without double counting", () => {
    const out = parseTokenTransfers([transfer(10n), { ...transfer(3n), topics: [transfer().topics[0]!, topic(other), topic(wallet)] }, { ...transfer(2n), topics: [transfer().topics[0]!, topic(wallet), topic(wallet)] }]);
    expect(walletDeltas(out, wallet)).toEqual([{ token, delta: "-7" }]);
    expect(walletDeltas(parseTokenTransfers([{ ...transfer(), topics: [transfer().topics[0]!, topic(wallet), topic(wallet)] }]), wallet)).toEqual([]);
  });
});
describe("same-block simulation", () => {
  it("sends one block with ordered calls and transfer tracing", async () => {
    const rpc = rpcFor(result());
    const out = await simulate(rpc, [call], { block: "0x64" });
    expect(out).toMatchObject({ simulated: true, balancesOverridden: false, block: "101", calls: [{ gasUsed: "21000" }] });
    expect(rpc.call).toHaveBeenCalledWith("eth_simulateV1", [{ blockStateCalls: [{ calls: [call] }], traceTransfers: true, validation: false, returnFullTransactions: false }, "0x64"]);
  });
  it("preserves sequential calls and returns no proposal", async () => {
    const block = result()[0]!; block.calls.push({ ...block.calls[0]!, logs: [] });
    const out = await simulate(rpcFor([block]), [call, call]);
    expect(out.calls).toHaveLength(2); expect(out.calls[1]?.transfers).toEqual([]);
    expect(out).not.toHaveProperty("io.paybox/transactionProposal");
  });
  it("labels overridden balances and sends stateDiff instead of replacing all storage", async () => {
    const overrides = dryRunOverrides(wallet, token, 1_000_000n, 9n);
    const rpc = rpcFor(result([])); const out = await simulate(rpc, [call], { stateOverrides: overrides });
    expect(out.balancesOverridden).toBe(true);
    const expected = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [wallet, 9n]));
    expect(mappingSlot(wallet, 9n)).toBe(expected);
    expect(overrides[token]?.stateDiff).toEqual({ [expected]: toHex(1_000_000n, { size: 32 }) });
    expect(overrides[wallet]).toEqual({ balance: toHex(10n ** 16n) });
  });
  it.each([[], {}, [{ number: "0x65", calls: [] }], [{ number: "0x65", calls: [{ status: "0x1", returnData: "0x", logs: [] }] }]])("rejects incomplete response %#", async response => await expect(simulate(rpcFor(response), [call])).rejects.toThrow("invalid-result"));
  it("refuses a reverted call even when subsequent calls succeed", async () => {
    const block = result()[0]!; block.calls[0]!.status = "0x0";
    await expect(simulate(rpcFor([block]), [call])).rejects.toMatchObject({ reason: "call-failed", callIndex: 0 });
  });
  it("refuses an error on a nominally successful call and missing logs", async () => {
    const r = result(); Object.assign(r[0]!.calls[0]!, { error: { code: 3, message: "private" } });
    await expect(simulate(rpcFor(r), [call])).rejects.toThrow("call-failed");
    const r2 = result(); delete (r2[0]!.calls[0] as { logs?: unknown }).logs;
    await expect(simulate(rpcFor(r2), [call])).rejects.toThrow("call-failed");
  });
  it("rejects unsafe inputs before RPC", async () => {
    const rpc = rpcFor(result());
    await expect(simulate(rpc, [])).rejects.toThrow("invalid-input");
    await expect(simulate(rpc, [call], { stateOverrides: { [token]: { state: {}, stateDiff: {} } } })).rejects.toThrow("invalid-input");
    await expect(simulate(rpc, [call], { block: "0x00" })).rejects.toThrow("invalid-input");
    expect(rpc.call).not.toHaveBeenCalled();
    for (const n of [-1n, 2n ** 256n]) expect(() => dryRunOverrides(wallet, token, n, 9n)).toThrow("invalid-input");
    expect(() => dryRunOverrides(wallet, wallet, 1n, 9n)).toThrow("invalid-input");
  });
});
