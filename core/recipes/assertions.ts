import { decodeAbiParameters } from "viem";
import type { Address, Hex } from "viem";
import type { Simulation } from "../simulate.js";
import { same, ZERO } from "./shared.js";
import type { Assertion, Identity, Recipe } from "./types.js";

export function entryAssertions(recipe: Recipe, identity: Identity, wallet: Address, amount: string, sim: Simulation, entryCount: number, allowanceReads: { token: Address; spender: Address; amount: string }[]): Assertion[] {
  const calls = sim.calls.slice(0, entryCount), transfers = calls.flatMap(c => c.transfers);
  const expectations = recipe.expect(identity, wallet, amount, sim), assertions: Assertion[] = [];
  for (const e of expectations) {
    if (e.kind === "token-out" || e.kind === "token-in") {
      const input = e.kind === "token-out";
      const actual = transfers.filter(t => same(t.token, e.token!) && same(input ? t.from : t.to, wallet) && !same(t.from, t.to)).reduce((sum, t) => sum + BigInt(t.amount), 0n);
      const pass = input ? actual === BigInt(e.amount!.atomic) : actual >= BigInt(e.minimum!.atomic);
      assertions.push({ code: input ? "ASSET_OUT" : "RECEIPT_IN", pass, detail: `${actual} units; required ${input ? e.amount!.atomic : e.minimum!.atomic}.` });
    } else if (e.kind === "allowance") {
      const read = allowanceReads.find(r => same(r.token, e.token!) && same(r.spender, e.spender!));
      assertions.push({ code: "ALLOWANCE_ZERO", pass: read?.amount === "0", detail: "Permission after entry must be read and equal zero." });
    } else if (e.kind === "return-code") {
      const result = calls.findLast(c => c.returnData.length === 66);
      assertions.push({ code: "RETURN_CODE", pass: result !== undefined && BigInt(result.returnData) === 0n, detail: "The market must return its success code, zero." });
    } else if (e.kind === "owner") {
      const nft = transfers.filter(t => t.kind === "erc721" && same(t.token, identity.receiptToken) && same(t.from, ZERO) && same(t.to, wallet));
      assertions.push({ code: "NFT_OWNER", pass: nft.length === 1, detail: "Exactly one new position NFT must arrive at the planned wallet." });
    } else if (e.kind === "position") {
      const minted = calls.flatMap(c => { try { return [decodeAbiParameters([{ type: "uint256" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }], c.returnData)]; } catch { return []; } });
      assertions.push({ code: "LIQUIDITY", pass: minted.some(m => m[1] > 0n), detail: "The new position must hold positive liquidity." });
    }
  }
  const allowed = identity.family === "lp-v3" ? [String(identity.details.token0), String(identity.details.token1)] : [identity.asset];
  assertions.push({ code: "NO_OTHER_OUT", pass: transfers.filter(t => same(t.from, wallet)).every(t => allowed.some(a => same(a, t.token))), detail: "Every outgoing token must be declared by the recipe." });
  if (identity.family !== "lp-v3") {
    const recognised = recipe.recognise({ transactionHash: `0x${"0".repeat(64)}` as Hex, from: wallet, to: identity.contract, blockNumber: `0x${BigInt(sim.block).toString(16)}`, status: "0x1", logs: calls.flatMap(c => c.logs) }, { chain: identity.chain, identities: [identity] });
    assertions.push({ code: "ENTER_EVENT", pass: recognised.some(a => a.kind === "enter" && same(a.actor, wallet) && a.amount === amount), detail: "The protocol event must credit the planned wallet and amount." });
  } else {
    const spent = transfers.filter(t => same(t.token, identity.asset) && same(t.from, wallet)).reduce((sum, t) => sum + BigInt(t.amount), 0n);
    assertions.push({ code: "ENTRY_BUDGET", pass: spent > 0n && spent <= BigInt(amount), detail: "The LP entry cannot spend more than its starting-token amount." });
  }
  return assertions;
}
export function assertPassed(assertions: readonly Assertion[]) {
  const failed = assertions.filter(a => !a.pass);
  if (failed.length) throw new Error(`SIM_FAILED: ${failed.map(a => a.code).join(", ")}`);
}
