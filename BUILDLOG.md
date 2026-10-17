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
- A proper website anyone can use.
- A way for Ditto to pay a few cents to a second source to double-check its numbers.
- A demo video made from the real thing, not mock-ups.

**Design.** I asked for a website that looks good, with nice colours and some movement, and isn't boring.

**Four real tests with my money.** I approved four tests in four different savings apps: Steakhouse, Clearstar, Compound and Fluid. Each time 1 dollar went in and all of it came back out. The receipts are on the website's Proofs page.

**Checking the work.** Each stage was checked before the next one started. The checks caught real mistakes before they reached anyone, for example:
- one deposit got stuck halfway through;
- good savings apps were wrongly turned away;
- a page on the website didn't work at all.

**Portal work.** I did the hackathon portal myself: uploading each version, filling in the settings and running the tests there.

**Submitted.** I submitted Ditto on 17 October, after the portal test passed.

**Demo video.** I chose to use a computer voice instead of my own. The video uses real recordings of the website and real numbers from my tests.
