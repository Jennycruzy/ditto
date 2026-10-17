# Security

Ditto moves real money only through PayBox, one transaction per approval. This page says what it does to keep that safe, and where the limits are.

## What Ditto never does

Borrow, leverage, bridge, unlimited approvals, approvals to anything but the recipe's own contract, transactions on contracts outside its six recipes, re-sending a stranger's calldata, or more than one transaction per proposal.

## How a move is kept safe

- **Decode, don't replay.** A stranger's transaction is only evidence. Ditto builds fresh standard calls (`approve`, `supply`, `deposit`, `mint`, `withdraw`, `redeem`) from fixed ABI fragments for the user's wallet.
- **Exit before entry.** Before a plan is signed, the whole round trip (enter, then exit everything) is simulated with `eth_simulateV1` at the current block, with token-transfer tracing. If the exit fails or returns too little, there is no plan.
- **Verified deployers only.** Discovery is open; execution is not. Each family has an onchain origin check:
  - **Aave:** the official PoolAddressesProvider, and a listed reserve.
  - **Compound v3:** the configurator.
  - **Moonwell:** the Comptroller.
  - **Morpho:** the MetaMorpho / Vault V2 factory check, plus Morpho's listing and size.
  - **Euler:** its factory.
  - **Spark and Fluid:** named addresses from their own repositories.
  - **Lido:** the canonical addresses.
  - **Uniswap and Aerodrome:** the NPM factory, and `getPool`.

  Anything else is explain-only (`UNKNOWN_PROVENANCE`).
- **Exact permissions.** Approvals are set to exactly the amount (zero-first for tokens that require it) and must read 0 after the deposit. `ditto_positions` lists leftover permissions with a one-step reset.
- **Signed plans.** `ditto_plan` signs the plan it checked with HMAC-SHA256 (`DITTO_PLAN_KEY`, a PayBox environment variable that is never bundled). A plan whose amount, contract or wallet was edited is refused (`PLAN_TAMPERED`). Plans expire after 30 minutes; `DITTO_MAX_AMOUNT` caps each plan.
- **Wallet binding.** PayBox chooses the signing wallet and does not tell the plugin, so Ditto binds it onchain:
  - **Entries:** the deposit is proposed only after the plan's approve is confirmed from the plan's wallet.
  - **Exits:** they start with a 0-value transaction from the wallet to itself, tagged with the plan id. They pay only to the plan's wallet.
  - **Proofs:** every proof re-checks the signer (`SIGNER_MISMATCH`).
- **Progress from this plan's own transactions.** A step counts only if its exact calldata, signer, block and decoded event match the plan. Ditto never infers progress from a position's size, so an existing position, interest, a lost session, a pending transaction (`WAIT_PENDING`) or a double submit (`DUPLICATE_ENTER`) cannot cause a wrong proposal.
- **Untrusted text.** Every string from a chain or an API (token names, vault names, third-party warnings, paid x402 bodies) is quoted, stripped of control characters, capped in length, and marked untrusted. It is never used as an instruction.
- **Stateless and bounded.** The plugin keeps no memory between calls. RPC calls are method-allowlisted, size-capped, timed out (3.5 s per request, 6.5 s per tool) and budgeted; on a throttled response, standard calls retry once on the chain's public RPC without the key. The plugin calls only its 12 listed hosts.
- **No secrets in code.** The Alchemy key is a PayBox brokered header and the plugin never reads it. CI scans every bundle for key patterns and the local key, and rejects source maps.

## Known limits

- **Signing wallet.** If the user's *other* PayBox wallet already holds an exact allowance to the same spender, PayBox could sign an entry from it. The proof will then fail with `SIGNER_MISMATCH`, and the step text names the wallet to select every time.
- **Simulations.** A simulation proves an exit works at one block, not that a market will have cash later. Exit classes (instant, queued, market) say this before every plan.
- **Second opinions.** These are informational and never block a plan by themselves.

## Reporting a problem

Please open a private security advisory on this repository, or contact the maintainer through GitHub ([@Jennycruzy](https://github.com/Jennycruzy)). Do not include private keys or seed phrases in any report.
