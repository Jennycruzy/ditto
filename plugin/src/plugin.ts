import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { evmOutputSchema, proposeEvm, proposeX402, x402OutputSchema } from "./paybox.js";
import { JsonRpc } from "../../core/rpc.js";
import type { Chain } from "../../core/chains.js";
import { chains } from "../../core/chains.js";
import { ExecutionEngine, buildExitPlan, buildRevokePlan } from "../../core/execution/engine.js";
import { verifyExecution } from "../../core/execution/proof.js";
import { positionsTool } from "../../core/execution/positions-tool.js";
import { evidenceWithFallback } from "../../core/execution/evidence.js";
import { executionRpcBudgets, type Config, type Target } from "../../core/execution/types.js";
import { secondOpinion, compareSecondOpinion } from "../../core/execution/opinion-tools.js";
import { explainTransaction, recognitionRpcBudgets } from "../../core/recognise/service.js";
import { walletMoves } from "../../core/recognise/wallet.js";
import type { AtlasChain, AtlasRow } from "../../core/atlas.js";
import { same } from "../../core/recipes/shared.js";
import type { Family } from "../../core/recipes/types.js";

// Ditto: copy a real onchain move for your wallet, through PayBox, and prove it landed.
// Every tool is stateless; the signed plan carries state between calls.
const PROTOCOL_VERSION = "2026-07-28";
const ATLAS = "https://jennycruzy.github.io/ditto-atlas/atlas";
const chain = z.enum(["base", "arbitrum", "optimism", "ethereum"]);
const family = z.enum(["aave-v3", "erc4626", "compound-v3", "moonwell", "lst", "lp-v3"]);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const target = { chain, family, contract: address };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const proposes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const rpc = (c: Chain, maxRequests: number) => new JsonRpc(c, { maxRequests });
// Atlas (§13.2): one bounded fetch of the published JSON; anything missing or stale means live chain reads instead.
async function atlas(c: Chain): Promise<AtlasChain | undefined> {
  try {
    const r = await fetch(`${ATLAS}/${c}.json`, { redirect: "error", signal: AbortSignal.timeout(2500) });
    if (!r.ok) return undefined;
    const text = await r.text(); if (text.length > 2_000_000) return undefined;
    const data = JSON.parse(text) as AtlasChain;
    return data?.version === 1 && data.chain === c && Array.isArray(data.rows) ? data : undefined;
  } catch { return undefined; }
}
function config(): Config {
  const cache = new Map<Chain, Promise<AtlasChain | undefined>>();
  const fromAtlas = async (c: Chain, contract: string) => {
    if (!cache.has(c)) cache.set(c, atlas(c));
    return (await cache.get(c))?.rows.find(r => same(r.contract, contract))?.evidence;
  };
  return { planKey: process.env.DITTO_PLAN_KEY, maxAmount: process.env.DITTO_MAX_AMOUNT || "1000", evidence: evidenceWithFallback(fromAtlas) };
}
const engine = (c: Chain, budget: number) => new ExecutionEngine(rpc(c, budget), config());
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v)) as Record<string, unknown>;
function answer(text: string, data: unknown, isError = false) {
  return { content: [{ type: "text" as const, text }], structuredContent: json(data), ...(isError ? { isError: true } : {}) };
}
// candidateId "chain:family:contract" from ditto_find or ditto_explain_tx, or the three fields directly.
const pick = z.object({ candidateId: z.string().regex(/^(base|arbitrum|optimism|ethereum):(aave-v3|erc4626|compound-v3|moonwell|lst|lp-v3):0x[0-9a-fA-F]{40}$/).optional(), chain: chain.optional(), family: family.optional(), contract: address.optional() });
function targetOf(a: z.infer<typeof pick>): Target {
  if (a.candidateId) { const [c, f, contract] = a.candidateId.split(":") as [Chain, Family, `0x${string}`]; return { chain: c, family: f, contract }; }
  if (!a.chain || !a.family || !a.contract) throw new Error("Give candidateId, or chain, family and contract.");
  return { chain: a.chain, family: a.family, contract: a.contract as `0x${string}` };
}
const goals: Record<string, Family[]> = { earn: ["aave-v3", "compound-v3", "moonwell", "erc4626", "lst", "lp-v3"], any: ["aave-v3", "compound-v3", "moonwell", "erc4626", "lst", "lp-v3"], lend: ["aave-v3", "compound-v3", "moonwell"], vault: ["erc4626"], stake: ["lst"], liquidity: ["lp-v3"] };
const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };
const place = (r: AtlasRow) => `${r.protocol.text.replace(/^"|"$/g, "")} (${r.contract.slice(0, 6)}…${r.contract.slice(-4)})`;

function createServer() {
  const server = new McpServer({ name: "ditto", version: "1.0.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool("ditto_find", {
    title: "Find real moves to copy",
    description: "Goal in, evidence out: the places real wallets put this asset in the last 24 hours that Ditto can rebuild for you and that passed every check (exit simulated, provenance verified, enough real use). Ranked by real use, never by yield. Start here.",
    inputSchema: z.object({ goal: z.enum(["earn", "lend", "vault", "stake", "liquidity", "any"]).default("earn"), chain: chain.default("base"), asset: z.string().max(42).default("USDC"), limit: z.number().int().min(1).max(10).default(5) }).strict(),
    annotations: readOnly,
  }, async ({ goal, chain: c, asset, limit }) => {
    const data = await atlas(c), families = goals[goal]!;
    if (!data) return answer(`Ditto's evidence index for ${c} is unavailable right now. You can still copy a specific transaction with ditto_explain_tx, or plan a known market with ditto_plan (all checks run live).`, { candidates: [], partial: true }, false);
    const wantsEth = /^(eth|weth|steth)$/i.test(asset);
    const rows = data.rows.filter(r => families.includes(r.family) && (wantsEth ? r.family === "lst" || r.family === "lp-v3" : r.family !== "lst"));
    const ok = rows.filter(r => r.verdict === "ok").slice(0, limit), refused = rows.filter(r => r.verdict === "refused").slice(0, 3);
    const stale = Date.now() - Date.parse(data.generatedAt) > 7_200_000;
    const total = rows.reduce((s, r) => s + r.evidence.deposits24h, 0);
    const lines = ok.map((r, n) => `${n + 1}) ${place(r)}, ${r.family}: ${r.evidence.deposits24h} deposits by ${r.evidence.uniqueWallets24h} wallets in 24h; holds ${Number(r.totalAssets.display).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${r.family === "lst" ? "ETH" : "USDC"}${r.apy7dPct !== null ? `; 7-day realised ${r.apy7dPct}% (information only)` : ""}; exit simulated: ${r.exitPreview?.returns.map(x => x.amount.display).join(" + ") ?? "n/a"} back for 1. candidateId ${r.id}`);
    const text = `${stale ? `Evidence is ${ago(data.generatedAt)} old; plans re-check everything live. ` : ""}On ${c}, Ditto saw ${total} real deposits in the last 24 hours into ${rows.length} places it can rebuild. ${ok.length ? `Most used today that passed every check:\n${lines.join("\n")}\nSay "plan 1 with 1 USDC" (ditto_plan) to see exactly what would move, or ditto_dry_run to try it with no money.` : "None passed every check right now."}${refused.length ? `\nRefused: ${refused.map(r => `${place(r)}: ${r.refusals.map(x => x.reason).join(" ")}`).join(" | ")}` : ""}`;
    return answer(text, { generatedAt: data.generatedAt, stale, candidates: ok, refused });
  });

  server.registerTool("ditto_explain_tx", {
    title: "Explain a transaction",
    description: "Paste any transaction hash or explorer link (Base, Arbitrum, Optimism, Ethereum). Ditto reads the receipt and says in plain words what it really did, through routers, smart wallets, Safes and bundlers, every token movement, and whether Ditto can rebuild it for your wallet (with a candidateId for ditto_plan).",
    inputSchema: z.object({ chain: chain.default("base"), tx: z.string().min(66).max(240) }).strict(),
    annotations: readOnly,
  }, async ({ chain: c, tx }) => {
    try { const r = await explainTransaction({ chain: c, tx }, rpc(c, recognitionRpcBudgets.explain)); return answer(r.text, r); }
    catch (e) { return answer(`Ditto could not read that transaction: ${String((e as Error).message).slice(0, 200)}. Check the chain and the hash.`, { error: true }, true); }
  });

  server.registerTool("ditto_wallet_moves", {
    title: "What did this wallet do?",
    description: "Recent recognised deposits and exits by any wallet (yours or one you follow), with a candidateId for each move Ditto can rebuild. Bounded history; partial results say so.",
    inputSchema: z.object({ chain: chain.default("base"), wallet: address, window: z.enum(["24h", "7d", "30d"]).default("7d"), limit: z.number().int().min(1).max(10).default(5) }).strict(),
    annotations: readOnly,
  }, async ({ chain: c, wallet, window, limit }) => {
    const r = await walletMoves({ chain: c, wallet, window, limit }, rpc(c, recognitionRpcBudgets.walletMoves));
    return answer(`${r.text}${r.moves.length ? `\n${r.moves.map(m => `${m.time.slice(0, 16)} ${m.description} candidateId ${m.candidateId}`).join("\n")}` : ""}`, r);
  });

  server.registerTool("ditto_plan", {
    title: "Build the exact plan",
    description: "Rebuild a move for YOUR wallet: fresh standard calls (never a stranger's calldata), exact token amounts simulated, the exit simulated now, every check re-run. Returns a signed plan to pass unchanged to ditto_step. Nothing is signed or moved here.",
    inputSchema: pick.extend({ wallet: address, amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/), slippageBps: z.number().int().min(0).max(100).default(50), acceptExit: z.enum(["queued", "market"]).optional() }).strict(),
    annotations: readOnly,
  }, async (a) => {
    try {
      const t = targetOf(a), r = await engine(t.chain, executionRpcBudgets.plan).enter({ ...t, wallet: a.wallet, amount: a.amount, slippageBps: a.slippageBps, ...(a.acceptExit ? { acceptExit: a.acceptExit } : {}) }) as Record<string, unknown>;
      return answer(String(r.text), r, r.verdict !== "ok");
    } catch (e) { return answer(String((e as Error).message), { verdict: "refused" }, true); }
  });

  server.registerTool("ditto_preview_step", {
    title: "Preview the next step",
    description: "Read-only twin of ditto_step: which step of the signed plan is next, in plain words, simulated now. Also reports waiting, done, or why nothing can be proposed. Call this before ditto_step to show the person what they will approve.",
    inputSchema: z.object({ plan: z.record(z.string(), z.unknown()), wallet: address, txHashes: z.array(hash).max(32).default([]) }).strict(),
    annotations: readOnly,
  }, async ({ plan, wallet, txHashes }) => {
    const c = chain.safeParse(plan.chain); if (!c.success) return answer("That is not a Ditto plan. Pass the signed plan from ditto_plan unchanged.", { done: false }, true);
    const r = await engine(c.data, executionRpcBudgets.step).step({ plan, wallet, txHashes }) as Record<string, unknown>;
    const { transaction: _t, ...rest } = r; return answer(String(r.text), rest);
  });

  server.registerTool("ditto_step", {
    title: "Propose the next transaction",
    description: "Money tool. Proposes exactly ONE transaction: the next step of the signed plan (bind, exact approve, enter or exit), after re-checking the plan's own confirmed transactions and simulating the step now. PayBox shows it for approval. Pass every hash PayBox returned for this plan. When PayBox says success, call ditto_step again or ditto_verify.",
    inputSchema: z.object({ plan: z.record(z.string(), z.unknown()), wallet: address, txHashes: z.array(hash).max(32).default([]) }).strict(),
    outputSchema: evmOutputSchema,
    annotations: proposes,
  }, async ({ plan, wallet, txHashes }) => {
    const c = chain.safeParse(plan.chain); if (!c.success) return answer("That is not a Ditto plan. Pass the signed plan from ditto_plan unchanged.", { done: false }, true);
    const r = await engine(c.data, executionRpcBudgets.step).step({ plan, wallet, txHashes }) as { text: string; transaction?: { to: string; value: string; data: string } };
    if (!r.transaction) return { content: [{ type: "text" as const, text: `No transaction proposed. ${r.text}` }], isError: true };
    const proposal = proposeEvm({ chain: `eip155:${chains[c.data].id}`, to: r.transaction.to, value: r.transaction.value, data: r.transaction.data });
    return { ...proposal, content: [{ type: "text" as const, text: `${r.text} Unsigned proposal prepared; PayBox validates it and asks for approval.` }] };
  });

  server.registerTool("ditto_verify", {
    title: "Proof card",
    description: "Proves onchain that the plan landed, from this plan's own transactions only: exact amount out, receipt token in, nothing else left the wallet, allowance back to 0, exit open (simulated now), gas paid. Never counts a position you already held.",
    inputSchema: z.object({ plan: z.record(z.string(), z.unknown()), txHashes: z.array(hash).min(1).max(32) }).strict(),
    annotations: readOnly,
  }, async ({ plan, txHashes }) => {
    const c = chain.safeParse(plan.chain); if (!c.success) return answer("That is not a Ditto plan.", {}, true);
    const r = await verifyExecution(engine(c.data, executionRpcBudgets.verify), { plan, txHashes: txHashes as `0x${string}`[] }) as Record<string, unknown>;
    return answer(String(r.text), r, !r.proof);
  });

  server.registerTool("ditto_positions", {
    title: "How's my money?",
    description: "Lists the wallet's positions in every Ditto family (lending, savings vaults, LP NFTs, staking), value now, the exit simulated now, and any leftover token permissions with a one-step reset. Each has an exitCandidateId for ditto_exit_plan.",
    inputSchema: z.object({ wallet: address, chains: z.array(chain).min(1).max(2).default(["base"]) }).strict(),
    annotations: readOnly,
  }, async ({ wallet, chains: list }) => {
    const r = await positionsTool({ wallet, chains: list }, { config: config(), rpc: c => rpc(c, executionRpcBudgets.positions), targets: async c => (await atlas(c))?.rows.map(x => ({ chain: c, family: x.family, contract: x.contract })) ?? [] });
    const text = r.positions.length || r.leftoverPermissions.length ? `${r.text}\n${r.positions.map((p, n) => `${n + 1}) ${p.valueNow.display} in ${p.family} ${p.contract.slice(0, 6)}…${p.contract.slice(-4)} on ${p.chain}; exit simulated now ${p.exitPreview.pass ? "works" : "FAILS"}: ${p.exitPreview.returns.map(x => x.amount.display).join(" + ")} back. exitCandidateId ${p.exitCandidateId}`).join("\n")}${r.leftoverPermissions.map(l => `\nLeftover permission: ${l.amount.display} to ${l.spender} on ${l.chain} (reset with ditto_exit_plan kind "revoke").`).join("")}\nSay "get me out of 1" for ditto_exit_plan.` : `${r.text} Nothing to exit.`;
    return answer(text, r);
  });

  server.registerTool("ditto_exit_plan", {
    title: "Get out",
    description: "Builds a signed exit plan for a position (all or part), paid only to your wallet, starting with a 0-value wallet-binding step; or, with kind \"revoke\", a plan that resets a leftover permission to 0. Execute with ditto_step, prove with ditto_verify.",
    inputSchema: pick.extend({ exitCandidateId: z.string().max(256).optional(), wallet: address, kind: z.enum(["exit", "revoke"]).default("exit"), amount: z.string().max(80).default("all"), tokenId: z.string().regex(/^[1-9][0-9]*$/).optional(), acceptExit: z.enum(["queued", "market"]).optional(), token: address.optional(), spender: address.optional() }).strict(),
    annotations: readOnly,
  }, async (a) => {
    try {
      const id = a.exitCandidateId?.split(":") ?? [];
      const t = a.exitCandidateId ? { chain: id[0] as Chain, family: id[1] as Family, contract: id[2] as `0x${string}` } : targetOf(a);
      const e = engine(t.chain, executionRpcBudgets.exitPlan);
      const tokenId = a.tokenId ?? (id[3] && /^[1-9][0-9]*$/.test(id[3]) ? id[3] : undefined); // LP exitCandidateId ends with the NFT id
      const r = (a.kind === "revoke" || id[3] === "revoke") ? await buildRevokePlan(e, { ...t, wallet: a.wallet, token: a.token, spender: a.spender ?? id[4] }) : await buildExitPlan(e, { ...t, wallet: a.wallet, amount: a.amount, ...(tokenId ? { tokenId } : {}), ...(a.acceptExit ? { acceptExit: a.acceptExit } : {}) });
      return answer(String(r.text), r, r.verdict !== "ok");
    } catch (e) { return answer(String((e as Error).message), { verdict: "refused" }, true); }
  });

  server.registerTool("ditto_dry_run", {
    title: "Try it with no money",
    description: "Simulates the whole move (approve, enter, exit) for any amount with balances overridden, so anyone can test Ditto with an empty wallet. Labelled SIMULATED. Never signs or proposes anything.",
    inputSchema: pick.extend({ wallet: address.optional(), amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/).default("1"), acceptExit: z.enum(["queued", "market"]).optional() }).strict(),
    annotations: readOnly,
  }, async (a) => {
    try {
      const t = targetOf(a), r = await engine(t.chain, executionRpcBudgets.dryRun).dryRun({ ...t, amount: a.amount, ...(a.wallet ? { wallet: a.wallet } : {}), ...(a.acceptExit ? { acceptExit: a.acceptExit } : {}) }) as Record<string, unknown>;
      return answer(String(r.text), r, r.verdict !== "ok");
    } catch (e) { return answer(String((e as Error).message), { verdict: "refused" }, true); }
  });

  server.registerTool("ditto_second_opinion", {
    title: "Pay for an independent second opinion",
    description: "Money tool (x402, at most $0.05). Pays the cheapest independent data source that covers this exact contract for its own read of the yield and size. Probes the price first without paying. Then pass the paid response to ditto_compare_opinion.",
    inputSchema: pick.extend({ source: z.enum(["auto", "mi-usdc", "pulse-vaults"]).default("auto"), maxUsd: z.string().regex(/^0(\.[0-9]{1,6})?$/).default("0.05") }).strict(),
    outputSchema: x402OutputSchema,
    annotations: proposes,
  }, async (a) => {
    try {
      const t = targetOf(a), r = await secondOpinion(engine(t.chain, 24), { ...t, source: a.source, maxUsd: a.maxUsd });
      if (r.verdict !== "ok" || !("x402" in r)) return { content: [{ type: "text" as const, text: `Nothing was paid. ${r.text}` }], isError: true };
      const proposal = proposeX402(r.x402!);
      return { ...proposal, content: [{ type: "text" as const, text: r.text }] };
    } catch (e) { return { content: [{ type: "text" as const, text: `Nothing was paid. ${String((e as Error).message)}` }], isError: true }; }
  });

  server.registerTool("ditto_compare_opinion", {
    title: "Compare the paid opinion with the chain",
    description: "Checks the paid response against Ditto's own onchain reading (7-day realised yield, size) for the same contract, matched by address. Says agrees, disagrees or not listed. Informational (check C15); never blocks a plan by itself.",
    inputSchema: pick.extend({ source: z.enum(["mi-usdc", "pulse-vaults"]), response: z.unknown(), requestId: z.string().max(128).optional() }).strict(),
    annotations: readOnly,
  }, async (a) => {
    try {
      const t = targetOf(a), r = await compareSecondOpinion(engine(t.chain, 32), { ...t, source: a.source, response: a.response, ...(a.requestId ? { requestId: a.requestId } : {}) });
      return answer(r.text, r, r.verdict === "refused");
    } catch (e) { return answer(String((e as Error).message), { verdict: "refused" }, true); }
  });

  server.registerTool("check_config", {
    title: "Check Ditto configuration",
    description: "Reports whether the plan-signing key and the amount limit are set, without revealing them.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ planKeySet: z.boolean(), planKeyLength: z.number(), maxAmountSet: z.boolean() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const out = { planKeySet: Boolean(process.env.DITTO_PLAN_KEY), planKeyLength: process.env.DITTO_PLAN_KEY?.length ?? 0, maxAmountSet: Boolean(process.env.DITTO_MAX_AMOUNT) };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  });

  return server;
}

serveStdio(createServer, { legacy: "reject" });
