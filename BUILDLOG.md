# Build log

> DRAFT for the author to check and edit before this repository is made public.

Ditto was built for the MoonPay PayBox hackathon (16–17 Oct 2026) by Jennycruzy. The code was written with AI coding agents (Claude Code and Codex) working under my direction. Each agent's work was reviewed at checkpoints before the next one began. This log records the decisions I made and the work I did myself.

## 17 Oct 2026

- **Picked the problem.** I set the bar: an agent-first plugin where a person states a goal and the agent copies a real onchain move. It had to execute genuinely new actions through PayBox (deposits, vaults, staking, liquidity) and verify them afterwards. Routing swaps to PayBox's existing integrations was not enough.
- **Rejected weaker directions, for stated reasons.** These included a crowded regional top-up idea, a low-value warranty idea, event-waiting watchers, escrow (already crowded), and a chat front-end for swaps.
- **Set the money rules.** I funded a capped test budget on Base ($8 USDC and $1 of ETH) and said I would not fund more. Every test had to return the money. Each live run is capped at 1 USDC.
- **Checked every blocker with real money before any spec.** In that check, a live $1 Aave supply and withdraw on Base proved the signing, broadcast and verification route.
- **Named it and wrote the pitch.** I chose the name Ditto and the final description used in the portal.
- **Decided: no submission until the build is finished.**
- **Product calls:**
  - fuse the evidence index into the product as a public atlas, with a liquidity family;
  - build a full human-facing site, not just an evidence page;
  - add paid x402 second opinions, because x402 is part of the brief;
  - have the video made from the real plugin route.
- **Ran the portal work:** uploads, network hosts, secrets, environment variables, hosted checks and Validate runs.
- **Approved the live runs** on Base: Steakhouse Prime USDC, Clearstar USDC, Compound v3 and Fluid. Each was 1 USDC in and all of it back out, with proofs in `evidence/proofs`.
- **Directed the design:** "make sure the site is well designed, with good colour themes and animation where necessary; don't make it boring."
- **Reviews:** checkpoint reviews (CP1–CP4b) found and fixed real defects before they shipped. Among them:
  - Arbitrum history used an unsupported query;
  - LP rebalances were wrongly marked partial;
  - step 2 was blocked after a confirmed approval;
  - steps were refused after a short pause on the free RPC tier;
  - healthy vaults were refused by a 7-day check that was a few seconds short;
  - the browser decoder never sent its requests.
