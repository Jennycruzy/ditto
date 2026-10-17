import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { encodeFunctionData, decodeFunctionResult, erc20Abi, parseAbi, maxUint256 } from "viem";
import { atomicAmount, evmOutputSchema, proposeEvm } from "./paybox.js";

// M0 probe build: blocker and assumption checks. Replaced by the full plugin in M6.
const PROTOCOL_VERSION = "2026-07-28";
const CHAIN = "eip155:8453";
const RPC = "https://mainnet.base.org";
const POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const A_USDC = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB";
const MAX_USDC = 1_000_000n; // 1 USDC cap per proposal

const poolAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
]);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const amountUsdc = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/);

function cappedAtomic(amount: string) {
  const atomic = BigInt(atomicAmount(amount, 6));
  if (atomic <= 0n || atomic > MAX_USDC) throw new Error("Amount must be above 0 and at most 1 USDC.");
  return atomic;
}

async function ethCall(to: string, data: string) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(4000),
  });
  const body = (await res.json()) as { result?: `0x${string}`; error?: { message: string } };
  if (!body.result) throw new Error(`RPC error: ${body.error?.message ?? res.status}`);
  return body.result;
}

// PayBox adds the Authorization header for this host from the portal secret.
const ALCHEMY = "https://base-mainnet.g.alchemy.com/v2";

async function alchemy<T>(method: string, params: unknown[]) {
  const res = await fetch(ALCHEMY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(4000),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { message: string } };
  if (body.result === undefined) throw new Error(`Alchemy error: ${body.error?.message ?? res.status}`);
  return body.result;
}

async function readUint(token: string, functionName: "balanceOf" | "allowance", args: readonly `0x${string}`[]) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName, args } as never);
  const out = await ethCall(token, data);
  return decodeFunctionResult({ abi: erc20Abi, functionName, data: out }) as bigint;
}

function createServer() {
  const server = new McpServer(
    { name: "ditto", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "read_aave_usdc_position",
    {
      title: "Read Aave USDC position on Base",
      description: "Reads the wallet's USDC balance, aBasUSDC balance and USDC allowance to the Aave v3 Pool on Base.",
      inputSchema: z.object({ wallet: address }).strict(),
      outputSchema: z.object({ wallet: z.string(), usdcAtomic: z.string(), aUsdcAtomic: z.string(), allowanceAtomic: z.string() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ wallet }) => {
      const w = wallet as `0x${string}`;
      const [usdc, aUsdc, allowance] = await Promise.all([
        readUint(USDC, "balanceOf", [w]),
        readUint(A_USDC, "balanceOf", [w]),
        readUint(USDC, "allowance", [w, POOL]),
      ]);
      const out = { wallet, usdcAtomic: usdc.toString(), aUsdcAtomic: aUsdc.toString(), allowanceAtomic: allowance.toString() };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    },
  );

  server.registerTool(
    "find_recent_aave_usdc_supplies",
    {
      title: "Find recent Aave USDC supplies on Base",
      description: "Lists recent real USDC deposits into Aave v3 on Base, with the contract and function each transaction called.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(10) }).strict(),
      outputSchema: z.object({
        examples: z.array(z.object({ hash: z.string(), from: z.string(), to: z.string(), selector: z.string(), usdc: z.number() }).strict()),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      const page = await alchemy<{ transfers: { hash: string; value: number | null }[] }>("alchemy_getAssetTransfers", [{
        toAddress: A_USDC, contractAddresses: [USDC], category: ["erc20"], order: "desc", maxCount: `0x${limit.toString(16)}`,
      }]);
      const examples = await Promise.all(page.transfers.map(async (t) => {
        const tx = await alchemy<{ from: string; to: string; input: string }>("eth_getTransactionByHash", [t.hash]);
        return { hash: t.hash, from: tx.from, to: tx.to, selector: tx.input.slice(0, 10), usdc: t.value ?? 0 };
      }));
      return { content: [{ type: "text", text: JSON.stringify(examples) }], structuredContent: { examples } };
    },
  );

  server.registerTool(
    "check_config",
    {
      title: "Check Ditto configuration",
      description: "Reports which Ditto environment variables are present, without revealing their values.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ planKeySet: z.boolean(), planKeyLength: z.number(), maxAmountSet: z.boolean() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const out = {
        planKeySet: Boolean(process.env.DITTO_PLAN_KEY),
        planKeyLength: process.env.DITTO_PLAN_KEY?.length ?? 0,
        maxAmountSet: Boolean(process.env.DITTO_MAX_AMOUNT),
      };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    },
  );

  server.registerTool(
    "propose_bind",
    {
      title: "Propose wallet bind",
      description: "Proposes a 0-value transaction from the wallet to itself, tagged with a plan id, on the chosen chain.",
      inputSchema: z.object({
        chain: z.enum(["base", "arbitrum", "optimism", "ethereum"]),
        wallet: address,
        planId: z.string().regex(/^[0-9a-f]{8}$/),
      }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ chain, wallet, planId }) => proposeEvm({
      chain: `eip155:${{ base: 8453, arbitrum: 42161, optimism: 10, ethereum: 1 }[chain]}`,
      to: wallet, value: "0", data: `0xd1770000${planId}`,
    }),
  );

  server.registerTool(
    "propose_usdc_approve_aave",
    {
      title: "Propose USDC allowance for Aave",
      description: "Proposes an exact USDC allowance (max 1 USDC) to the Aave v3 Pool on Base.",
      inputSchema: z.object({ amountUsdc }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ amountUsdc }) => proposeEvm({
      chain: CHAIN, to: USDC, value: "0",
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [POOL, cappedAtomic(amountUsdc)] }),
    }),
  );

  server.registerTool(
    "propose_aave_supply_usdc",
    {
      title: "Propose Aave USDC supply",
      description: "Proposes supplying USDC (max 1 USDC) to the Aave v3 Pool on Base on behalf of the wallet.",
      inputSchema: z.object({ wallet: address, amountUsdc }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ wallet, amountUsdc }) => proposeEvm({
      chain: CHAIN, to: POOL, value: "0",
      data: encodeFunctionData({ abi: poolAbi, functionName: "supply", args: [USDC, cappedAtomic(amountUsdc), wallet as `0x${string}`, 0] }),
    }),
  );

  server.registerTool(
    "propose_aave_withdraw_all_usdc",
    {
      title: "Propose Aave USDC withdraw (all)",
      description: "Proposes withdrawing the wallet's entire Aave USDC position on Base back to the wallet.",
      inputSchema: z.object({ wallet: address }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ wallet }) => proposeEvm({
      chain: CHAIN, to: POOL, value: "0",
      data: encodeFunctionData({ abi: poolAbi, functionName: "withdraw", args: [USDC, maxUint256, wallet as `0x${string}`] }),
    }),
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
