import { encodeFunctionData, parseAbi, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
import { fragments } from "./abis.js";
import { stepSchema, type Json, type Step } from "./schemas.js";

const allowed = new Set<string>(Object.values(fragments));
export function makeStep(kind: Step["kind"], to: Address, fragment: string, args: Json[], expect: Step["expect"] = [], value = "0"): Step {
  if (!allowed.has(fragment)) throw new Error("FAMILY_DISABLED");
  return stepSchema.parse({ kind, to, abiFragment: fragment, selector: toFunctionSelector(fragment), args, value, expect });
}
export function encodeStep(input: Step): { to: Address; data: Hex; value: string } {
  const step = stepSchema.parse(input);
  if (step.kind === "bind") {
    if (step.abiFragment !== "bind" || step.selector !== "0xd1770000" || step.value !== "0" || step.args.length !== 1 || typeof step.args[0] !== "string" || !/^[a-f0-9]{64}$/.test(step.args[0])) throw new Error("PLAN_TAMPERED");
    return { to: step.to, value: "0", data: `0xd1770000${step.args[0]}` };
  }
  if (!allowed.has(step.abiFragment) || step.selector !== toFunctionSelector(step.abiFragment)) throw new Error("PLAN_TAMPERED");
  const abi: Abi = parseAbi([step.abiFragment] as readonly string[]);
  const fn = abi[0];
  if (!fn || fn.type !== "function") throw new Error("PLAN_TAMPERED");
  return { to: step.to, value: step.value, data: encodeFunctionData({ abi, functionName: fn.name, args: step.args as never }) };
}
