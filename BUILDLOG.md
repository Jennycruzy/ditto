# Build log

Ditto was built for the MoonPay PayBox hackathon on 16 and 17 October 2026 by Jennycruzy.

I used AI coding agents (Claude Code and Codex) to write the code. I decided what to build, set the rules, tested it with my own money and checked the work at each stage before the next stage started. This log is what I did and what I decided.

## 17 October 2026

**The idea.** I wanted a plugin where you tell your agent a goal, like "put 1 USDC to work on Base", and it copies something real people already did onchain. It also had to do things PayBox couldn't already do: deposits, vaults, staking and liquidity, not only swaps. And it had to prove afterwards that the move really happened.

**What I said no to.** I looked at other ideas first: phone top-ups, warranties, bots that wait for events, escrow and a chat front end for swaps. I dropped them because they were already common or not useful enough.

**Money rules.** I put a small test budget on Base, $8 in USDC and $1 in ETH, and said there would be no more. Every test had to give the money back, and no single run could use more than 1 USDC.

**Test before planning.** Before writing any plan I made sure the hard parts worked with real money. I put $1 into Aave on Base and took it back out. That proved Ditto could build the transaction, PayBox could sign and send it, and Ditto could check the result.

**Name and pitch.** I named it Ditto and wrote the description used in the hackathon portal.

**Finish first, then submit.** I decided not to submit until the build was finished and tested.

**Product decisions:**
- Turn the research data into a public map of where real wallets are putting money today.
- Build a proper website people can use, not just a page of data.
- Let Ditto pay for a second opinion through x402, because x402 is part of the hackathon brief.
- Make the demo video from the real plugin and real transactions.

**Design.** I asked for a site that is well designed, with good colours and some animation, and not boring.

**Live runs with real money.** I approved four runs on Base: Steakhouse Prime USDC, Clearstar USDC, Compound v3 and Fluid. Each one put in 1 USDC and took all of it back out. The receipts are in `evidence/proofs` and on the site's Proofs page.

**Checking the work.** At each stage the work was reviewed before moving on. The reviews caught real problems before they shipped, for example:
- Arbitrum history was being fetched in a way the provider doesn't support.
- Some liquidity moves were wrongly marked as only half done.
- The second step of a deposit was blocked even after the first step went through.
- Steps were refused after a short wait on the free data plan.
- Good vaults were refused because a 7-day check came up a few seconds short.
- The website's transaction reader never sent its requests.

**Portal work.** I did the hackathon portal work myself: uploading each version, adding the allowed websites, secrets and settings, and running the hosted tests.

**Submitted.** I submitted Ditto on 17 October, before the 8pm EDT deadline, after the hosted plan test passed (4.4 seconds).

**Video.** I asked for a demo video with a computer voice and captions. The website parts are real screen recordings of the live site.
