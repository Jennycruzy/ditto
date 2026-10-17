# Third-party code, data and services

## Code bundled into the plugin

| Component | Version | Licence | Use |
|---|---|---|---|
| PayBox plugin starter | 1.0.2 | Provided by PayBox for the MoonPay hackathon; used as provided | MCP server scaffold, `proposeEvm` / `proposeX402` helpers, conformance scripts. Starter files are listed with their hashes in `plugin/manifest.json`; `plugin/src/plugin.ts` was rewritten for Ditto |
| @modelcontextprotocol/server | 2.0.0 | MIT | MCP server over stdio |
| viem | 2.51.3 | MIT | ABI encoding/decoding, address checks, transaction parsing |
| zod | 4.4.3 | MIT | Input, output and response schemas |

Build and test only (not bundled): TypeScript 5.9.3 (Apache-2.0), esbuild 0.28.2 (MIT), vitest 4.0.18 (MIT), tsx (MIT), ajv (MIT).

## Services the plugin calls

| Service | Host | Use |
|---|---|---|
| Alchemy | `*-mainnet.g.alchemy.com` (Base, Arbitrum, Optimism, Ethereum) | Chain reads, `eth_simulateV1`, `alchemy_getAssetTransfers` (key as a PayBox brokered header) |
| Public RPCs | `mainnet.base.org`, `arb1.arbitrum.io`, `mainnet.optimism.io`, `ethereum-rpc.publicnode.com` | Fallback for standard reads when Alchemy throttles; the browser decoder |
| Morpho API | `api.morpho.org` | Vault listing status, size and Morpho's own warnings (quoted as untrusted) |
| Ditto atlas | `jennycruzy.github.io` | Published evidence index (this project) |
| Market Intelligence API | `api.marketintelligenceapi.com` | Paid x402 second opinion ($0.002), USDC lending markets |
| OnchainPulse | `onchainpulse.theaslangroupllc.com` | Paid x402 second opinion ($0.02), Base vault APY |

Two further x402 endpoints (Otto yield markets and recommendations) were tested and are disabled: on 17 Oct 2026 they rejected PayBox's payment proof.

## Contract addresses

Every contract Ditto can execute against comes from the protocol's own published source. The source URL is recorded beside each address in `core/provenance.json`:
- Aave address book;
- Compound v3 deployments;
- Moonwell docs;
- Morpho, Euler, Spark and Fluid repositories;
- Lido docs;
- Uniswap and Aerodrome deployment pages.

## Site

The site (in the public `ditto-atlas` repository) uses Google Fonts (Geist, Geist Mono, Instrument Serif; SIL Open Font License) and the same browser bundle of Ditto's core.
