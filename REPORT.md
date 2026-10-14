# Prototype report (2026-10-14)

## What works

- **Participant:** campaign overview → campaign detail with budget breakdown, rules and a
  live allocation preview → contribute simulated USDC → allocation freezes at full funding →
  *My positions* (allocation; money contributed, spent and returned; rewards received,
  locked, claimable and claimed) → claim → reward history and refunds.
- **Operator:**
  - campaign tabs with start, end and cancel;
  - provider-selection table with each offer's eligibility reasons and ranking;
  - machine timeline;
  - incidents with acknowledge, automated retry, deploy-a-chosen-offer and resolve;
  - reward receipt and unlock entry;
  - frozen allocations and budget;
  - miner stake and operating windows;
  - adapter and authority boundaries;
  - "create campaign";
  - audit log (append-only events with postings) and ledger balances with invariant checks.
- **Simulation controls:** demo clock, machine failure, market modes, add capacity, fill
  funding with simulated participants, wallet top-up, stake slash, reset. Kept in a separate,
  clearly marked panel.
- **Persistence:** SQLite event store with replay on restart (server). The hosted preview
  saves to the artifact's private database.

## Acceptance criteria → evidence

| # | Criterion | Covered by |
| --- | --- | --- |
| 1 | Participant contributes simulated funds | `journey.test.ts`, `api.test.ts`, UI journey |
| 2 | Invalid / below-minimum / insufficient / over-target rejected | `journey.test.ts` (#2), `api.test.ts`, UI journey (inline messages) |
| 3 | Funding completes, allocations freeze, no overfunding or late contributions | `journey.test.ts` (#1/3), concurrency test in `persistence.test.ts` |
| 4 | Funded campaign starts its simulated miner on an eligible (not cheapest) offer | `journey.test.ts` (#4) |
| 5 | Failure triggers replacement (skipping a failed deployment) | `journey.test.ts` (#5), UI journey |
| 6 | No working replacement → operator incident; manual recovery | `journey.test.ts` (#6), outage test, UI journey |
| 7 | Reward receipt recorded and attributed to the earning campaign | `journey.test.ts` (#7) |
| 8 | Locked tokens cannot be claimed | `journey.test.ts` (#8), `api.test.ts`, UI journey |
| 9 | Unlocked tokens claimable in exact proportions | `journey.test.ts` (#9), path-independence test |
| 10 | Repeats cannot double-credit or double-pay | idempotency + duplicate-reference tests (engine, HTTP, after restart) |
| 11 | Ending a campaign preserves reward rights (late receipts and unlocks) | `journey.test.ts` (#11) |
| 12 | Later campaigns on the same miner don't dilute earlier rights | `journey.test.ts` (#12): window split, idle gap unattributed, old unlock → old campaign |
| 13 | Unused money returned separately from spent | `journey.test.ts` (#13): exact spend reconciled line by line |
| 14 | State survives restart | `persistence.test.ts`, `api.test.ts` (server restart), real binary restarted on the same DB |

## What was tested

- `npm test`: 61 passing tests in 5 files.
  - money parsing and apportionment, including randomized splits;
  - the full acceptance journey, plus funding failure, cancellation, provider outage,
    distribution path-independence, stake slash, and demo mode switched off;
  - replay equality;
  - SQLite restart, ledger projection versus replayed balances, rejected commands writing
    nothing, concurrent commands, and reset;
  - the HTTP journey, restart, and operator token;
  - the posting policy for each service identity.
- `npm run build`: typecheck passes; server, web and the single-file preview all build.
- UI checks: `scripts/ui-journey.mjs` drove the whole journey by clicking through the real UI
  in headless Chromium. It ran against the server build and against the preview build, which
  runs the in-page engine with browser storage. It also checked phone width and dark mode for
  horizontal overflow and found none. Usability fixes made from the screenshots:
  - provider table moved to full width;
  - phone cost table simplified;
  - journey checklist role labels made clearer;
  - reward history now shows how much of your share arrived locked;
  - audit filter now built from live data.
- A real bug was found and fixed. Reducers had stored event payloads by reference, so later
  events silently rewrote earlier ones and replay double-counted funding. Reducers now get a
  private copy, and a replay-equality test guards it.
- An independent adversarial review of the engine (with reproducing probes) confirmed five
  issues. All were fixed and have regression tests (61 tests in total):
  1. A blacklist incident on a healthy miner allowed a second machine to be deployed while
     the first kept running unbilled. Now provisioning refuses while a machine runs, a
     blacklisted miner is never redeployed, ending a campaign stops every running machine,
     and the reducer rejects two running machines.
  2. Equal timestamps written two different ways crashed point-in-time receipts. Timestamps
     are now normalised before comparison.
  3. Receipt and unlock references were case-sensitive, so a re-cased hex hash could
     double-credit. They are now compared case-insensitively.
  4. Two browser tabs could interleave writes to the preview's saved log. Writes are now
     checked against the stored head and serialised with a lease. An unreadable log is set
     aside, never wiped.
  5. Two minor fixes: "fill funding" ignored high minimums, and full refunds did not record
     which allocation they belonged to.
  The review also confirmed as correct: contribution rules, freezing, settlement sums, window
  boundaries, unlock routing, claims, idempotency across actors and commands, replay after a
  JSON round trip, budget and clock handling, and serialized and atomic writes.

## What is simulated

- **Funds:** USDC and FLOP balances and transfers, including the claim "transactions"
  (`sim-tx-…`).
- **GPU market:** offers, prices and reliability are illustrative. Deploy outcomes are
  scripted (offer O-106 always fails to start). Health failures happen only when you trigger
  them.
- **Rewards:** receipts and unlocks are entered by the operator; nothing is observed on a
  chain.
- **Clock:** the demo clock advances only from the controls. Deadlines and term ends trigger
  when it passes them.
- **Not built:** real authentication. Roles come from a header or the UI toggle.

## Decisions made (reversible)

- Built as a standalone TypeScript project: Node 22 built-in SQLite, a dependency-free
  `node:http` server, React and esbuild.
- Preview: the container cannot expose a port, so the preview is a private claude.ai artifact
  running the same engine in the page. It is private to you.
- FLOP uses 18 decimals. Hardware spec: 1 GPU with 80 GB or more, on-demand, a verified host,
  and at least 97% reliability.
- Budget lines: 84% GPU rental, 10% replacement reserve, 6% deployment and storage.
  The setup fee is 0.50 USDC per attempt, with at most 3 automated attempts per recovery run.
- A contribution of exactly the remaining amount is allowed when it is below the minimum.
- Unused budget is refunded to the original contributor.
- Reward attribution is by time overlap with operating windows. Unlocks follow the receipt
  that earned them.
- The rounding residual is carried in the campaign. Its final disposition is undecided.
- The FLOP docs (flop.finance) were unreachable from this environment (DNS and proxy blocked).
  Protocol facts come from your 2026-10-14 summary and are labelled unverified in the UI.

## Known limitations

- The preview's artifact-database persistence could not be exercised from the build session.
  The database is empty until the page is first opened, which seeds it. If the database is
  unavailable, the page falls back to browser storage and the banner says so.
- Two tabs writing at once: the second write is refused and the page reloads. Retry after a
  few seconds.
- No authentication, accounts or KYC. There is one demo participant.
- Allocations cannot be transferred, and no insurance or cover exists. Both are intentional.
- Duration bonus, fee model, stake supplier and unlock-inference funding are all unresolved.

## Launch dependencies

1. Jurisdiction and legal analysis of the reward-share product: securities or collective
   investment status, and licensing.
2. Custody structure for contributions and reward tokens. An operator-controlled wallet is
   custodial.
3. Customer eligibility, KYC/AML and sanctions screening.
4. Customer terms and risk disclosures: slashing, protocol changes, early termination,
   residual handling.
5. The agreed fee model: profit definition, token valuation, eligible costs and timing.
6. Who supplies the miner stake and bond, and on what terms.
7. Who pays for the future paid inference that unlocks historical airdrops.
8. Real integrations: stablecoin payments, the FLOP miner runtime and settlement (verify
   against current docs), GPU provider adapters, monitoring and founder alerting.
9. Security review, key separation (GPU credentials kept apart from reward signing) and an
   independent accounting review.
