# Flop Pool — fixed FLOP mining campaigns (prototype)

People fund a fixed mining campaign together. Each contributor gets a frozen percentage of the
rewards that campaign actually receives. The service finds GPUs, deploys and monitors the miner,
replaces failed machines, keeps the books and distributes rewards.

**This is a demo.** USDC, FLOP, GPU machines, provider offers, health events and reward receipts
are all simulated. No real funds move, no GPUs are rented, no FLOP network or wallet is contacted.
It is an independent prototype, not affiliated with or endorsed by the FLOP project.

- Hosted private preview: https://claude.ai/artifact/MpvjNujUYReYd3nXZh7WQ6 (only you can open it)
- Results, test coverage and launch dependencies: [REPORT.md](REPORT.md)

## Run it

Requires Node 22.5+ (uses the built-in `node:sqlite`; no native dependencies).

```sh
npm install
npm test            # 61 tests: accounting, acceptance journey, restart, HTTP API, policy, regressions
npm run build       # typecheck + server + web + single-file preview page
npm start           # http://127.0.0.1:8787 (loopback only)
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Listen address. Kept on loopback by default. |
| `DB_PATH` / `DATA_DIR` | `data/flop-pool.db` | SQLite event store. Delete it to start over. |
| `DEMO_MODE` | `true` | `false` refuses all demo controls (clock, failures, faucet, reset). |
| `OPERATOR_TOKEN` | unset | If set, operator and demo requests need `Authorization: Bearer <token>`. |
| `VAST_API_KEY`, `RUNPOD_API_KEY` | unset | Only shown as "missing/set" on the console. No real adapter exists. |

**Reset:** Operator → Simulation controls → *Reset demo*, or `POST /api/demo/reset` with
`X-Demo-Role: demo`. This replaces the event log with the seed.

**UI check:** `node scripts/ui-journey.mjs http://127.0.0.1:8787` (or `artifact`) drives the
whole journey in headless Chromium and writes screenshots to `.screens/`.

## Seeded demo

- Miner account `M-01` (SOFT tier) with a placeholder 10,000 FLOP stake. The stake supplier is
  "Unresolved". It is not paid from any campaign budget.
- **Campaign 1**: 3,000 USDC target, 100 USDC minimum, 14-day funding deadline, 30-day term.
  2,400 USDC is already funded by four simulated participants, so 600 USDC remains.
- **Campaign 2**: a later 3,000 USDC / 30-day campaign on the same miner account. Use it to
  check that later campaigns don't dilute earlier ones.
- The demo participant ("You") starts with 1,000 simulated USDC.
- The overview shows a nine-step checklist of the full journey that ticks itself off as you go.

## Architecture

```
src/domain/          pure TypeScript, no I/O — shared by server and browser
  money.ts           bigint base units, exact parsing/formatting, largest-remainder apportionment
  engine.ts          Tx/Engine: commands → events, actor checks, posting policy, idempotency
  state.ts           the reducer (only place state changes) + replay
  accounts.ts        ledger accounts + POSTING_POLICY (who may move which asset where)
  commands/          campaigns, orchestrator, rewards, demo controls, seed
  providers/         adapter interface, simulated marketplace, offer selection
  views.ts           read models + ledger invariant checks
  service.ts         Engine + EventStore; serializes commands
src/server/          node:http API + SQLite event store (events + postings tables)
src/web/             React UI; api/http.ts (server) or api/embedded.ts (in-page engine)
scripts/build.mjs    esbuild: dist/server, dist/web, dist/artifact/flop-pool.html
```

**Event sourcing.** Every command runs against a draft copy of state. All changes are events
applied by one reducer. The caller persists the events atomically and only then commits the
draft. A rejected command or failed write changes nothing. On startup the server replays
the `events` table, so state survives restarts. A test checks that replay reproduces
byte-identical state. Each money movement is a balanced double-entry posting carried inside
its event and projected to a `postings` table in the same transaction.

**Two hosts, one engine.** `npm start` serves the UI against the Node API, with SQLite as the
backend. The hosted preview cannot reach this container, so it bundles the same engine into
the page. That page persists the event log to the artifact's private database, falling back
to browser storage, and the banner says which store is in use.

### HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | store kind, event count, demo clock |
| GET | `/api/views/{home,campaign,portfolio,operator,ledger,audit,meta}` | `?viewer=&id=&campaignId=&limit=` |
| POST | `/api/commands` | `{ type, input, idempotencyKey }`; role via `X-Demo-Role` (participant/operator/demo) |
| POST | `/api/demo/reset` | demo/operator only |

Bigints travel as `{"$n":"123"}`. The role headers are a demo affordance, not authentication.
Real deployments need real auth.

Commands: `contribution.submit`, `claim.submit` (participant); `campaign.create|start|end|cancel`,
`ops.retryRecovery` (optionally with an operator-chosen `offerId`), `incident.acknowledge|resolve`,
`reward.recordReceipt`, `reward.recordUnlock` (operator); `demo.advanceClock|injectFailure|
setMarketMode|addCapacity|fillFunding|topUp|simulateSlash` (demo).

## Accounting model and assumptions

- **Units.** USDC uses 6 decimals. FLOP uses 18 decimals, which is an *assumption*: the
  official precision was not verified. All arithmetic is `bigint`; displays truncate and never
  round up. SQLite stores amounts as exact integer strings, because FLOP base units overflow
  64-bit integers. Sum them in application code, not with `SUM()`.
- **Contributions.** These are rejected: invalid input, more than 6 decimals, below the
  minimum, insufficient balance, above the remaining target, after funding closes, and after
  the deadline. One exception: if the remaining amount is below the minimum, a contribution
  of exactly the remaining amount is accepted, so a campaign can't get stuck just short.
- **Allocation (documented assumption).** One fixed term, allocated pro rata to funded
  contributions. There is no duration bonus, because none was agreed. Contributions per
  participant are aggregated and frozen the moment funding reaches the target
  (`shareNumerator / shareDenominator`, exact).
- **Operating money.** The orchestrator pays the simulated provider from the campaign budget:
  a setup fee per deployment attempt, plus GPU rental metered as
  `floor(rate × elapsed since start)`, which gives the same total however often the clock is
  advanced. Nothing accrues while the miner is down. When a campaign ends (term complete or
  ended early), the unspent budget is returned pro rata by largest remainder: the parts sum
  exactly, and residual micro-units go to the largest remainders, with ties broken by
  allocation id. Spent money is reported separately and never refunded. A funding failure or
  a cancellation before start refunds every contribution in full.
- **Platform fee.** The model is `unconfigured` and charges zero, in both USDC and FLOP.
  `src/domain/fees.ts` is where the agreed model goes. The open questions are listed there
  and in the UI.
- **Miner stake** is a separate account on the miner, with an "Unresolved" supplier. The
  campaign budget is never used for it. A simulated slash debits only that stake account.
  Participant rewards are untouched, and downtime is never treated as fraud.

### Rewards: the seven concepts kept separate

| Concept | Where it lives |
| --- | --- |
| Money spent on compute | `expenditure.recorded`, `campaign:<id>:budget → external:provider:*` |
| FLOP supplied as stake | `miner:<id>:stake` |
| Reward entitlements | frozen allocations (`Entitlement`, with ownership history) |
| Tokens received | `RewardReceipt` + per-campaign `RewardLot`s |
| Locked / unavailable | `campaign:<id>:rewards-locked`, `miner:<id>:unattributed-locked` |
| Unlocked and claimable | `campaign:<id>:rewards-undistributed → entitlement:<id>:claimable` |
| Distributed | `claim.paid`, `entitlement:<id>:claimable → user:<id>:wallet` |

- **Attribution.** A miner account can be reused across campaigns. Each campaign records its
  operating window on the miner. A receipt's earning period is split across windows by time
  overlap. Time outside every window stays *unattributed* on the miner and is never given to
  the latest campaign. A point-in-time receipt belongs to the window that contains it.
- **Locked rewards and unlocks.** A receipt has a liquid part and a locked part. Airdrop
  receipts default to 25% liquid, per the draft design. An unlock references a specific
  receipt, and its tokens go to the campaign(s) that earned that receipt, even after the
  campaign ended or while a later campaign is running. Who pays for future inference that
  triggers unlocks is unresolved and is not funded by any campaign.
- **Distribution.** Each holder is credited `floor(cumulative distributable × share) −
  already credited`. This is path-independent: any batching of receipts and unlocks gives the
  same credits. The rounding residual (fewer base units than holders) stays in the campaign's
  undistributed account and is carried forward. It is never swept to the operator.
- **Claims** pay exactly the credited-but-unclaimed balance. Locked shares are shown but are
  never claimable.
- **Duplicates.** Every command carries an idempotency key. Replaying a key returns the
  original result; reusing a key for a different request is rejected. Receipts and unlocks
  also need a unique external reference.
- **Custody.** Campaign and allocation accounts are book entries. In a real system, the tokens
  would sit in an operator-controlled wallet, and that is custodial.

## Orchestration and integration boundaries

```
not_started → provisioning → healthy ⇄ recovering → manual_intervention (incident) → recovering → healthy
                                                   any → stopped (campaign ended)
```

- **Selection.** An offer must first pass hard requirements: available, enough VRAM,
  non-interruptible, reliability ≥ 97%, verified host, not excluded earlier in this campaign,
  and estimated cost for the remaining term ≤ remaining budget. Eligible offers are then
  ranked by `estimated total ÷ reliability`. The cheapest advertised offers in the seed fail
  the hard requirements, and the UI shows why.
- **Recovery.** When a machine fails a health check, its host is excluded and the next
  eligible offer is deployed, with up to 3 attempts per run. If no eligible offer remains, or
  every attempt fails, an incident opens. Its escalation recipient is the founder, but
  nothing is sent in this prototype. The operator can then retry, deploy a specific offer, or
  end the campaign. The simulated market has scripted outcomes and three modes (normal,
  deploy outage, no capacity), plus "add capacity".
- **Adapters.** `providers/types.ts` defines `ComputeProviderAdapter`. Only
  `SimulatedProvider` exists. Each step is already a separate event, so a real async adapter
  can complete `deployment.requested` from a worker. Missing credentials disable only their
  adapter.
- **Authority separation.** `POSTING_POLICY` enforces three narrow rights: the orchestrator
  identity can only pay providers from a campaign budget; the rewards identity can only move
  FLOP along receipt → locked → undistributed → claimable → holder; settlement can only
  return USDC to wallets. Tests check that each identity is refused everything else.
- **FLOP.** No API was invented or called. Protocol facts in `config.ts` come from the
  2026-10-14 summary of the public draft docs. Those pages could not be fetched from the build
  environment, so the facts are unverified.

## Future direction (data model only)

- **Allocation trading.** Allocations keep an ownership history. A sale would transfer only
  the remaining entitlement, never the operating budget. Claimed rewards never move again.
  Locked and credited-but-unclaimed amounts need explicit rules. Not built.
- **Slashing cover, rolling pools, backstops, airdrop credit sales.** Not built, and nothing
  in the UI implies them.
