# 〃 Ditto

**Ditto is a PayBox plugin that lets your AI assistant put your crypto to work by copying what real people did today, safely, with your approval, and with proof it worked.**

Built for the MoonPay PayBox hackathon. Live on Base.

[Watch the demo on X](https://x.com/jennyoliver57/status/2111605427334963507) ([MP4](https://github.com/Jennycruzy/ditto/releases/download/demo-video/ditto-demo.mp4)) · [Website](https://ditto-atlas.vercel.app) · [Today](https://ditto-atlas.vercel.app/today.html) · [Decode any transaction](https://ditto-atlas.vercel.app/tx.html) · [Proofs](https://ditto-atlas.vercel.app/proofs.html) · [For judges](https://ditto-atlas.vercel.app/judges.html) · [Safety](SECURITY.md) · [Build log](BUILDLOG.md)

## How it works

When an AI assistant wants to move your money, your wallet usually shows a wall of code like `0x617ba037…` and asks you to approve it. Ditto replaces that with something you can understand and check:

1. You tell your assistant: "Put 1 USDC to work on Base."
2. Ditto looks at where real people put USDC in the last 24 hours.
3. It only offers places that pass every safety check: real people using it, real money in it, a known creator, no sudden drops, and a way out that works right now. Everything else is turned away, with the reason.
4. Before anything moves, it shows the plan in plain words: what leaves your wallet, what you get back, and how you get out.
5. PayBox asks you to approve each step. Permission is only ever for the exact amount, never unlimited.
6. Afterwards, Ditto checks the blockchain and proves what happened: what left, what arrived, that nothing else moved, and that the permission went back to zero.
7. "How's my money?" shows where it is. "Get me out" brings it back, with proof again.

You can also paste any transaction you saw someone make. Ditto explains what it really did and builds a fresh, safe version for your wallet. Copying someone's transaction exactly as it was worked only 3 times out of 47 in testing, which is why Ditto rebuilds it instead.

## The 30-second story

On 17 Oct 2026 a smart wallet deposited 644.83 USDC into the Steakhouse Prime USDC vault on Base, through a Morpho bundler ([0x48c2…abb2](https://basescan.org/tx/0x48c2353ddc7b815454489bdac3ed343e53650f1aaa1854d1197d3cd2fafaabb2)). PayBox's approval window would only show raw calldata for a move like that. Ditto read the receipt, recognised the deposit, and rebuilt it for a different wallet as two fresh standard calls: an exact 1.000000 USDC approve, then `deposit(1 USDC, wallet)`. Before signing anything it simulated the whole round trip: deposit, then take it all out, 0.999999 USDC back.

Then it ran for real, through PayBox signing:

| Step | Transaction | Proof |
|---|---|---|
| Approve exactly 1 USDC | [0x6c34…8b56](https://basescan.org/tx/0x6c34b9c787a317dfb5aabe722841f4b913a2e8aab1b1b76548f830d3ee1e8b56) | |
| Deposit 1 USDC | [0xcd7d…79bc](https://basescan.org/tx/0xcd7d37eb66921a42d6c2d25c268cd010cfd5fadee1d4a1d32dbcfed1c28879bc) | 1.000000 USDC out, 0.957244 shares in, nothing else moved, allowance back to 0, exit open |
| Bind the wallet (0-value, to itself) | [0x8377…6edd](https://basescan.org/tx/0x83779879b800df9fe405acfd82ffee2d80d96f01a490dcf352eca9daa1436edd) | |
| Take it all out | [0xe9f8…a6e2](https://basescan.org/tx/0xe9f82b9bb6e95607de3c3d1127ad0f6dd909069fd1c0c368b9b1f25fd5f0a6e2) | 1.000000 USDC back, allowance 0 |

Three more families ran the same way: the Clearstar USDC vault, Compound v3 and Fluid. All of them landed both ways ([evidence/proofs](evidence/proofs)).

## What you say to your agent

| You say | Ditto does |
|---|---|
| "Put 1 USDC to work on Base." | `ditto_find`: the places real wallets used in the last 24 h that passed every check, ranked by real use (never by yield) |
| "Do what 0x48c2… did, with 1 USDC." | `ditto_explain_tx` → `ditto_plan`: decodes the stranger's move, rebuilds it for you |
| "How's my money? Get me out of 1." | `ditto_positions` → `ditto_exit_plan` → `ditto_step` → `ditto_verify` |
| "Try it with no money." | `ditto_dry_run`: the full round trip, simulated with balances overridden |

## Install

1. In PayBox, enable **Ditto** (until review, it is listed under Unofficial plugins for its owner).
2. The plugin calls only these hosts: `base-mainnet.g.alchemy.com`, `arb-mainnet.g.alchemy.com`, `opt-mainnet.g.alchemy.com`, `eth-mainnet.g.alchemy.com`, `mainnet.base.org`, `arb1.arbitrum.io`, `mainnet.optimism.io`, `ethereum-rpc.publicnode.com`, `jennycruzy.github.io`, `api.morpho.org`, `api.marketintelligenceapi.com`, `onchainpulse.theaslangroupllc.com`.
3. One secret: an Alchemy key as a brokered `Authorization: Bearer …` header for the four Alchemy hosts. PayBox adds it; the plugin never reads it.
4. Environment: `DITTO_PLAN_KEY` (64 hex characters; signs plans) and `DITTO_MAX_AMOUNT` (per-plan cap in asset units).

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `ditto_find` | read | Goal → evidence-backed places, most used today, with every check |
| `ditto_explain_tx` | read | What a transaction really did (routers, ERC-4337 bundlers, Safes, Morpho bundlers), and whether Ditto can rebuild it |
| `ditto_wallet_moves` | read | Recognised deposits and exits by any wallet |
| `ditto_plan` | read | The exact signed plan for your wallet: amounts simulated, exit simulated, checks re-run |
| `ditto_preview_step` | read | The next step in plain words, simulated now |
| `ditto_step` | **money** | Proposes exactly one EVM transaction to PayBox |
| `ditto_verify` | read | The proof card, from this plan's own transactions only |
| `ditto_positions` | read | Positions, value now, exit simulated now, leftover permissions |
| `ditto_exit_plan` | read | A signed exit (or permission-reset) plan |
| `ditto_dry_run` | read | The full round trip with no money |
| `ditto_second_opinion` | **money (x402, ≤ $0.05)** | Pays an independent data source for its own read of the same contract |
| `ditto_compare_opinion` | read | Agrees / disagrees / not listed, against Ditto's own chain reads |
| `check_config` | read | Whether the signing key and cap are set (never their values) |

## How it decides

**Evidence → recipe → checks → exit → proof.**

- **Evidence.** The [atlas](https://github.com/Jennycruzy/ditto-atlas) crawls recent real deposits every 2 hours. It recognises them from receipt events, not calldata, so moves made through routers and smart wallets still count.
- **Recipe.** Six families, each a standard call builder:
  - Aave v3;
  - ERC-4626 savings vaults (Morpho, Euler, Spark, Fluid);
  - Compound v3;
  - Moonwell;
  - Lido;
  - Uniswap v3 / Aerodrome Slipstream liquidity.
- **Checks.** Real use (5+ deposits by 3+ wallets in 24 h), age ≥ 30 days, size ≥ $100k, no share-price drop over 7 days, pause and cap flags, token sanity, a verified deployer (factory or registry), gas, and a simulated round trip.
- **Steps.** One transaction per PayBox approval. Progress counts only this plan's own confirmed transactions, so retries, lost sessions and double submits are safe.
- **Proof.** Exact amount out, receipt in, nothing else moved, allowance 0, exit open, gas paid.

## Safety

See [SECURITY.md](SECURITY.md). In short, Ditto never borrows, leverages or bridges. It never makes unlimited approvals or approves anything but the recipe's own contract. It never acts on contracts outside its recipes, never re-sends a stranger's calldata, and never puts more than one transaction behind an approval.

## Coverage (as published, 17 Oct 2026 22:38 UTC)

From [atlas/meta.json](https://jennycruzy.github.io/ditto-atlas/atlas/meta.json):
- **Base:** 12 places checked, 102 recognised deposits in 24 h, 7 passed every check.
- **Optimism:** 4 places, 25 deposits, 2 passed.

Arbitrum and Ethereum rotate in every 3 hours. Places that fail, with their reasons, are listed on [Today](https://jennycruzy.github.io/ditto-atlas/today.html).

In the coverage study, blindly replaying strangers' transactions worked for 3 of 47 on Base. Rebuilding fresh standard calls is what makes copying work.

## Verify it yourself

```
pnpm install && pnpm verify
```

`pnpm verify` re-reads every live proof from the chain's public RPC (no key) and checks:
- every transaction succeeded and was signed by the plan's wallet;
- exactly 1 USDC went in;
- at least 0.999 USDC came back.

The site's [Proofs](https://jennycruzy.github.io/ditto-atlas/proofs.html) page does the same in your browser.

## Development

```
pnpm install
pnpm test          # 478 unit, golden-fixture and adversarial tests
pnpm build         # core bundles (dist/core.mjs, dist/browser.mjs, dist/crawl.mjs)
cd plugin && pnpm install && pnpm test   # typecheck, two identical builds, PayBox conformance
```

## Built with

- The PayBox plugin starter 1.0.2 (MCP server, `proposeEvm`, `proposeX402`).
- viem 2.51.3 and zod 4.4.3.
- Alchemy, Morpho's public API, and public chain RPCs.

Details are in [THIRD_PARTY.md](THIRD_PARTY.md).

## Build log

[BUILDLOG.md](BUILDLOG.md): the decisions behind Ditto, and who made them.

## Licence

MIT. See [LICENSE](LICENSE).
