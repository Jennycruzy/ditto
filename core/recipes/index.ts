import { aaveV3 } from "./aave-v3.js";
import { erc4626 } from "./erc4626.js";
import { compoundV3 } from "./compound-v3.js";
import { moonwell } from "./moonwell.js";
import { lst } from "./lst.js";
import { lpV3 } from "./lp-v3.js";
import type { Family, Recipe } from "./types.js";

// Enablement is decided by golden evidence; unproven families cannot execute.
export const recipes: Readonly<Record<string, Recipe>> = { "aave-v3": aaveV3, erc4626, "compound-v3": compoundV3, moonwell, lst, "lp-v3": lpV3 };
export { prepareLpEntry, prepareLpSwap, positionFragment } from "./lp-v3.js";
export { aaveMinimum, normalizedIncomeFragment } from "./aave-v3.js";
export { exitMinimum } from "./shared.js";
export { entryAssertions, assertPassed } from "./assertions.js";
export function recipe(family: Family): Recipe {
  const result = recipes[family]; if (!result) throw new Error("FAMILY_DISABLED"); return result;
}
export type * from "./types.js";
