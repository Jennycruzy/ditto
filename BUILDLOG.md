# Build log

I built Ditto for the MoonPay PayBox hackathon on 16 and 17 October 2026.

AI coding tools (Claude Code and Codex) wrote the code. I chose what to build, set the rules, tested it with my own money, and checked the work at each stage before the next stage began. This is what I did and decided.

## 17 October 2026

**The idea.** You tell your AI assistant what you want, like "put 1 dollar of USDC to work". Ditto finds where real people put their money today, makes the same move for your wallet, asks you to approve it, and then checks that it really happened. It does more than swap one coin for another: it can put money into savings and lending apps too.

**Ideas I dropped.** Before this I looked at phone top-ups, warranties, bots that wait for something to happen, holding money for two people, and a chat screen for swapping coins. I dropped them because lots of people were already building them or they weren't useful enough.

**Money rules.** I put a small test budget in my wallet: 8 dollars of USDC and 1 dollar of ETH for fees. I said there would be no more. Every test had to give the money back, and no test could use more than 1 dollar.

**I tested the hard part first.** Before any planning, I put 1 dollar into Aave (a lending app) and took it back out. That showed the whole thing could work: Ditto builds the move, PayBox asks me and sends it, and Ditto checks the result.

**Name and pitch.** I named it Ditto and wrote the description in the hackathon portal.

**Finish first.** I decided not to submit until it was built and tested.

**What I decided it should have:**
- A public page showing where real people are putting their money today.
- A way for Ditto to pay a few cents to a second source to double-check its numbers.

**Website.** I designed the website.

**Four real tests with my money.** I approved four tests in four different savings apps: Steakhouse, Clearstar, Compound and Fluid. Each time 1 dollar went in and all of it came back out. The receipts are on the website's Proofs page.

**Tests that failed, and how we fixed them.** Each stage was tested before the next one started. These are the tests that failed and what we changed to make them pass:

- **Arbitrum history came back empty every time.** Ditto asked the data service for a kind of record it doesn't keep on Arbitrum. Fix: only ask for that record on Ethereum. Now real Arbitrum history loads, and a test uses it.
- **Some liquidity moves were marked as only half done.** The person had closed their old position and opened a new one in the same move, so the old one was already gone when Ditto looked. Fix: look one block earlier, just before it closed.
- **Explanations were unreadable.** They said things like "644830186 units of 0x8335…". Fix: they now say "644.83 USDC", give the app's name, and describe the route in words.
- **Reading a wallet's history was too slow.** It took 53 requests for 5 transactions. Fix: smarter searching cut it to 17 requests, about 2 seconds.
- **A one-unit shortfall on Optimism.** An Aave test on Optimism gave back 999,998 units when the rule asks for at least 999,999. We kept the rule as it was and didn't loosen it to make the test pass.
- **The second step of a deposit was blocked.** After the first step (giving permission) went through, Ditto refused the second. Plans also failed if the permission was already exactly the right amount. Fix: every plan now remembers who it gave permission to and checks that.
- **Closing a two-part liquidity position crashed.** Fix: each part is now closed and counted on its own.
- **Errors were vague.** A failed exit just said "simulation failed". Fix: it now says plainly that the way out doesn't work, and wrong input says which field is wrong.
- **36 checks failed after a code change** because the saved examples were out of date. Fix: we made the examples again and read every difference. Only the wording had changed, plus two moves that are now correctly refused.
- **Steps were refused after a short wait.** The free data service was a few seconds behind. Fix: Ditto waits for it to catch up instead of refusing.
- **Good savings apps were turned away.** A 7-day safety check came up a few seconds short of 7 days. Fix: it now counts days properly.
- **The website's "what did this transaction do?" page never worked.** The browser blocked the way it sent requests. Fix: one-line change, and now it reads the chain live.
- **Portal tests failed on the last night** when the data service refused the key. Fix: Ditto falls back to free public services, so it keeps working.
- **The map of where people put money broke** when a chain name was blank. Fix: it now skips blank or unknown names.

**Portal work.** I did the hackathon portal myself: uploading each version, filling in the settings and running the tests there.

**Submitted.** I submitted Ditto on 17 October, after the portal test passed.
