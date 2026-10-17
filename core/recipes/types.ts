import type { Address, Hex } from "viem";
import type { Chain } from "../chains.js";
import type { Rpc } from "../rpc.js";
import type { Json, Position, Step } from "../schemas.js";
import type { Log, Simulation } from "../simulate.js";

export type Family = "aave-v3" | "erc4626" | "compound-v3" | "moonwell" | "lst" | "lp-v3";
export type Identity = {
  family: Family; chain: Chain; contract: Address; asset: Address | "native"; receiptToken: Address;
  assetDecimals: number; receiptDecimals: number; totalAssets: string; paused: boolean; cap: string;
  provenance: { verified: boolean; source: string; registry?: Address; listed?: boolean; sizeUsd?: string; named?: boolean };
  details: Record<string, Json>;
};
export type Receipt = { transactionHash: Hex; from: Address; to: Address | null; blockNumber: Hex; status: Hex; logs: Log[] };
export type Recognised = { kind: "enter" | "exit" | "other"; family: Family; contract: Address; asset: Address | "native"; amount: string; actor: Address; txHash: Hex; receiptAmount?: string; tokenId?: string };
export type RecogniseContext = { chain: Chain; identities: readonly Identity[]; lpPositions?: Record<string, { pool: Address; token0: Address; token1: Address; tickLower: number; tickUpper: number }> };
export type IdentifyOptions = { asset?: Address; wallet?: Address; block?: Hex | "latest"; now?: number; listing?: { address: Address; chain: Chain; listed: boolean; totalAssetsUsd: string; fetchedAt: string } };
export type BuildOptions = { allowance?: string; zeroFirst?: boolean; slippageBps?: number; now?: number; acceptExit?: "queued" | "market"; tokenId?: string; liquidity?: string; shares?: boolean; positionBalance?: string; min0?: string; min1?: string; halfWidthTicks?: number; amount0?: string; amount1?: string };
export type Assertion = { code: string; pass: boolean; detail: string };
export interface Recipe {
  family: Family; chains: readonly Chain[];
  recognise(receipt: Receipt, ctx: RecogniseContext): Recognised[];
  identify(contract: Address, chain: Chain, rpc: Rpc, options?: IdentifyOptions): Promise<Identity | null>;
  buildEnter(identity: Identity, wallet: Address, amount: string, options?: BuildOptions): Step[];
  buildExit(identity: Identity, wallet: Address, amount: string | "all", options?: BuildOptions): Step[];
  expect(identity: Identity, wallet: Address, amount: string, sim: Simulation): Step["expect"];
  position(identity: Identity, wallet: Address, rpc: Rpc): Promise<Position>;
}
