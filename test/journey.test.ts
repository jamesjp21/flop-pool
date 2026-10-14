// End-to-end acceptance journey against the domain engine (criteria 1–13).
// Criterion 14 (restart) is covered in persistence.test.ts and api.test.ts.

import { describe, expect, it } from 'vitest';
import { acct } from '../src/domain/accounts';
import { DEMO } from '../src/domain/config';
import { flop, mulDivFloor, usdc } from '../src/domain/money';
import { encode } from '../src/domain/serialize';
import { balanceOf, replay } from '../src/domain/state';
import { checkInvariants, viewPortfolio } from '../src/domain/views';
import { DEMO_ACTOR, ME, OP, expectError, key, participant, run, seededEngine } from './helpers';

const C1 = 'C-001';
const C2 = 'C-002';

describe('acceptance journey', () => {
  const e = seededEngine();
  const s = () => e.state;
  const wallet = (u: string, a: 'USDC' | 'FLOP') => balanceOf(s(), acct.wallet(u), a);
  const claimable = (entId: string) => balanceOf(s(), acct.claimable(entId), 'FLOP');
  const myEnt = (cid: string) => Object.values(s().entitlements).find((x) => x.campaignId === cid && x.holderId === DEMO.demoUserId)!;

  it('starts from the seeded example: $3,000 target, $600 remaining, $100 minimum', () => {
    const c = s().campaigns[C1];
    expect(c.terms.targetUnits).toBe(usdc('3000'));
    expect(c.fundedUnits).toBe(usdc('2400'));
    expect(c.terms.minContributionUnits).toBe(usdc('100'));
    expect(c.terms.termDays).toBe(30);
    expect(c.terms.costLines.reduce((t, l) => t + l.units, 0n)).toBe(c.terms.targetUnits);
    expect(c.terms.costLines.find((l) => l.key === 'platform_fee')!.units).toBe(0n);
    expect(c.terms.feeModel).toEqual({ kind: 'unconfigured' });
    expect(wallet(DEMO.demoUserId, 'USDC')).toBe(usdc('1000'));
    // Miner stake is recorded separately; the campaign budget is not used for it.
    expect(balanceOf(s(), acct.stake('M-01'), 'FLOP')).toBe(flop('10000'));
    expect(balanceOf(s(), acct.budget(C1), 'USDC')).toBe(usdc('2400'));
  });

  it('2. rejects invalid, below-minimum, insufficient-balance and over-target contributions', () => {
    const before = wallet(DEMO.demoUserId, 'USDC');
    for (const bad of ['abc', '-5', '0', '1.0000001', '', '1e3']) {
      expectError(() => run(e, ME, 'contribution.submit', { campaignId: C1, amount: bad }), 'INVALID_AMOUNT');
    }
    expectError(() => run(e, ME, 'contribution.submit', { campaignId: C1, amount: '50' }), 'BELOW_MINIMUM');
    expectError(() => run(e, ME, 'contribution.submit', { campaignId: C1, amount: '700' }), 'EXCEEDS_REMAINING');
    // Avery spent the whole seeded balance on the first contribution.
    expectError(() => run(e, participant('u-avery'), 'contribution.submit', { campaignId: C1, amount: '100' }), 'INSUFFICIENT_BALANCE');
    expectError(() => run(e, ME, 'contribution.submit', { campaignId: 'C-999', amount: '100' }), 'NOT_FOUND');
    expectError(() => run(e, OP, 'contribution.submit', { campaignId: C1, amount: '100' }), 'FORBIDDEN');
    expect(wallet(DEMO.demoUserId, 'USDC')).toBe(before);
    expect(s().campaigns[C1].fundedUnits).toBe(usdc('2400'));
  });

  it('1/3. accepts a contribution, is idempotent, then completes funding and freezes allocations', () => {
    const k = key('contrib');
    const r1 = e.execute({ type: 'contribution.submit', input: { campaignId: C1, amount: '250' }, idempotencyKey: k }, ME);
    expect(r1.duplicate).toBe(false);
    const r2 = e.execute({ type: 'contribution.submit', input: { campaignId: C1, amount: '250' }, idempotencyKey: k }, ME);
    expect(r2.duplicate).toBe(true);
    expect(r2.result).toEqual(r1.result);
    expect(wallet(DEMO.demoUserId, 'USDC')).toBe(usdc('750'));
    expectError(() => e.execute({ type: 'contribution.submit', input: { campaignId: C1, amount: '300' }, idempotencyKey: k }, ME), 'IDEMPOTENCY_CONFLICT');
    expect(s().campaigns[C1].status).toBe('funding');
    expect(s().campaigns[C1].entitlementIds).toHaveLength(0);

    const r3 = run(e, ME, 'contribution.submit', { campaignId: C1, amount: '350' });
    expect(r3.fundingClosed).toBe(true);
    expect(r3.allocationPercent).toBe('20.0000');
    const c = s().campaigns[C1];
    expect(c.status).toBe('funded');
    expect(c.entitlementIds).toHaveLength(5);
    const ents = c.entitlementIds.map((id) => s().entitlements[id]);
    expect(ents.reduce((t, x) => t + x.shareNumerator, 0n)).toBe(usdc('3000'));
    expect(ents.every((x) => x.shareDenominator === usdc('3000'))).toBe(true);
    expect(myEnt(C1).contributedUnits).toBe(usdc('600'));

    // Closed: no more contributions, so no overfunding.
    expectError(() => run(e, ME, 'contribution.submit', { campaignId: C1, amount: '100' }), 'CAMPAIGN_NOT_OPEN');
    expect(s().campaigns[C1].fundedUnits).toBe(usdc('3000'));
  });

  it('4. starts the funded campaign on an eligible offer, not the cheapest advertised rate', () => {
    expectError(() => run(e, OP, 'campaign.start', { campaignId: C2 }), 'INVALID_STATE');
    expectError(() => run(e, ME, 'campaign.start', { campaignId: C1 }), 'FORBIDDEN');
    const r = run(e, OP, 'campaign.start', { campaignId: C1 });
    expect(r.opsStatus).toBe('healthy');
    const c = s().campaigns[C1];
    const dep = s().deployments[c.ops.activeDeploymentId!];
    expect(dep.offer.id).toBe('O-104');
    const ev = s().evaluations[c.ops.lastEvaluationId!];
    const cheapest = ev.checks.find((x) => x.offerId === 'O-101')!;
    expect(cheapest.eligible).toBe(false);
    expect(cheapest.reasons.join(' ')).toMatch(/Interruptible/);
    expect(c.spentUnits).toBe(usdc('0.50'));
    expect(s().miners['M-01'].windows).toEqual([{ campaignId: C1, from: c.startedAt }]);
    expectError(() => run(e, OP, 'campaign.start', { campaignId: C1 }), 'INVALID_STATE');
  });

  it('meters GPU rental exactly as time passes', () => {
    run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 48 });
    const dep = s().deployments['D-001'];
    expect(dep.rentalCostUnits).toBe(usdc('1.89') * 48n);
    expect(s().campaigns[C1].spentUnits).toBe(usdc('0.50') + usdc('1.89') * 48n);
  });

  it('5. a machine failure triggers automated replacement (skipping a failed deployment)', () => {
    const r = run(e, DEMO_ACTOR, 'demo.injectFailure', { campaignId: C1, kind: 'gpu_error' });
    expect(r.opsStatus).toBe('healthy');
    const c = s().campaigns[C1];
    const deps = c.ops.deploymentIds.map((id) => s().deployments[id]);
    expect(deps.map((d) => [d.offer.id, d.status])).toEqual([
      ['O-104', 'failed'],
      ['O-106', 'deploy_failed'],
      ['O-107', 'running'],
    ]);
    expect(c.ops.openIncidentIds).toHaveLength(0);
  });

  it('6. when no replacement works, an operator incident appears; operator recovers manually', () => {
    run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 24 });
    const r = run(e, DEMO_ACTOR, 'demo.injectFailure', { campaignId: C1 });
    expect(r.opsStatus).toBe('manual_intervention');
    const c = s().campaigns[C1];
    expect(c.ops.openIncidentIds).toHaveLength(1);
    const inc = s().incidents[c.ops.openIncidentIds[0]];
    expect(inc.kind).toBe('recovery_exhausted');
    expect(inc.escalation.recipient).toBe('Founder');
    expect(inc.escalation.channel).toMatch(/Not sent/);
    expectError(() => run(e, OP, 'incident.resolve', { incidentId: inc.id }), 'INVALID_STATE');

    run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 6 });
    // Downtime accrues no rental.
    const spentWhileDown = s().campaigns[C1].spentUnits;
    run(e, DEMO_ACTOR, 'demo.addCapacity');
    const retry = run(e, OP, 'ops.retryRecovery', { campaignId: C1 });
    expect(retry.opsStatus).toBe('healthy');
    expect(s().deployments[retry.activeDeploymentId].offer.id).toBe('O-109');
    expect(s().campaigns[C1].ops.downtimeMs).toBe(6 * 3_600_000);
    expect(s().campaigns[C1].spentUnits).toBe(spentWhileDown + usdc('0.50'));
    run(e, OP, 'incident.resolve', { incidentId: inc.id, note: 'Recovered on O-109' });
    expect(s().campaigns[C1].ops.openIncidentIds).toHaveLength(0);
  });

  let blockReceipt = '';
  let airdropReceipt = '';
  it('7. records a reward receipt and attributes it to the campaign that earned it', () => {
    run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 24 * 5 });
    const c = s().campaigns[C1];
    const r = run(e, OP, 'reward.recordReceipt', { minerId: 'M-01', kind: 'block_reward', amount: '1000', earnedFrom: c.startedAt, earnedTo: s().clock, externalRef: 'sim-block-0001' });
    blockReceipt = r.receiptId;
    expect(r.lots).toEqual([{ lotId: `${r.receiptId}-L1`, campaignId: C1, amountUnits: flop('1000'), lockedUnits: 0n }]);
    // Credits follow frozen allocation: you hold 20%.
    expect(claimable(myEnt(C1).id)).toBe(flop('200'));
    expectError(
      () => run(e, OP, 'reward.recordReceipt', { minerId: 'M-01', kind: 'block_reward', amount: '1000', earnedFrom: c.startedAt, earnedTo: s().clock, externalRef: 'sim-block-0001' }),
      'DUPLICATE_REFERENCE',
    );
    // The orchestrator identity cannot record rewards.
    expectError(() => run(e, { kind: 'orchestrator', id: 'svc' }, 'reward.recordReceipt', {}), 'FORBIDDEN');
  });

  it('8. locked tokens cannot be claimed', () => {
    const c = s().campaigns[C1];
    const r = run(e, OP, 'reward.recordReceipt', { minerId: 'M-01', kind: 'airdrop', amount: '4000', earnedFrom: c.startedAt, earnedTo: s().clock, externalRef: 'sim-airdrop-0001' });
    airdropReceipt = r.receiptId;
    expect(s().receipts[airdropReceipt].lockedUnits).toBe(flop('3000')); // draft: 25% liquid
    const ent = myEnt(C1);
    expect(claimable(ent.id)).toBe(flop('400'));
    const cl = run(e, ME, 'claim.submit', { entitlementId: ent.id });
    expect(cl.units).toBe(flop('400'));
    expect(wallet(DEMO.demoUserId, 'FLOP')).toBe(flop('400'));
    // Your 600 FLOP share of the locked airdrop is visible but not claimable.
    expect(viewPortfolio(s(), DEMO.demoUserId).positions.find((p) => p.campaign.id === C1)!.rewards.lockedShareUnits).toBe(flop('600'));
    expectError(() => run(e, ME, 'claim.submit', { entitlementId: ent.id }), 'NOTHING_TO_CLAIM');
    expectError(() => run(e, participant('u-bo'), 'claim.submit', { entitlementId: ent.id }), 'FORBIDDEN');
  });

  it('9. unlocked tokens become claimable in the correct proportions', () => {
    expectError(() => run(e, OP, 'reward.recordUnlock', { receiptId: airdropReceipt, amount: '3000.000000000000000001', externalRef: 'sim-unlock-x' }), 'LOCKED_INSUFFICIENT');
    run(e, OP, 'reward.recordUnlock', { receiptId: airdropReceipt, amount: '1500', externalRef: 'sim-unlock-0001' });
    const c = s().campaigns[C1];
    expect(c.rewards.distributableUnits).toBe(flop('3500'));
    for (const id of c.entitlementIds) {
      const ent = s().entitlements[id];
      expect(ent.creditedUnits).toBe(mulDivFloor(flop('3500'), ent.shareNumerator, ent.shareDenominator));
    }
    expect(claimable(myEnt(C1).id)).toBe(flop('300'));
    // Residual base units are explicit and smaller than the number of holders.
    const residual = balanceOf(s(), acct.rewardsUndistributed(C1), 'FLOP');
    expect(residual).toBe(c.rewards.distributableUnits - c.rewards.creditedUnits);
    expect(residual < BigInt(c.entitlementIds.length)).toBe(true);
  });

  it('10. repeated requests cannot double-credit or double-pay', () => {
    const ent = myEnt(C1);
    const k = key('claim');
    const a = e.execute({ type: 'claim.submit', input: { entitlementId: ent.id }, idempotencyKey: k }, ME);
    const b = e.execute({ type: 'claim.submit', input: { entitlementId: ent.id }, idempotencyKey: k }, ME);
    expect(b.duplicate).toBe(true);
    expect(b.result).toEqual(a.result);
    expect(wallet(DEMO.demoUserId, 'FLOP')).toBe(flop('700'));
    expectError(() => run(e, ME, 'claim.submit', { entitlementId: ent.id }), 'NOTHING_TO_CLAIM');
    expectError(() => run(e, OP, 'reward.recordUnlock', { receiptId: airdropReceipt, amount: '1', externalRef: 'sim-unlock-0001' }), 'DUPLICATE_REFERENCE');
    const totalCredited = Object.values(s().entitlements).filter((x) => x.campaignId === C1).reduce((t, x) => t + x.creditedUnits, 0n);
    expect(totalCredited).toBe(s().campaigns[C1].rewards.creditedUnits);
  });

  it('13. ending the campaign returns unused money separately from money spent', () => {
    const walletBefore = wallet(DEMO.demoUserId, 'USDC');
    const spentBefore = s().campaigns[C1].spentUnits;
    run(e, OP, 'campaign.end', { campaignId: C1, reason: 'Ended early for the demo' });
    const c = s().campaigns[C1];
    expect(c.status).toBe('ended');
    const st = c.settlement!;
    // 4 setup fees + O-104 for 48 h + O-107 for 24 h + O-109 for 120 h; no rental while down.
    const expectedSpend = usdc('0.50') * 4n + usdc('1.89') * 48n + usdc('3.69') * 24n + usdc('1.99') * 120n;
    expect(spentBefore).toBe(expectedSpend);
    expect(st.spentUnits).toBe(expectedSpend);
    expect(st.spentUnits + st.unusedUnits).toBe(usdc('3000'));
    expect(st.fee.usdcUnits).toBe(0n);
    const refunds = st.refundIds.map((id) => s().refunds[id]);
    expect(refunds.reduce((t, r) => t + r.units, 0n)).toBe(st.unusedUnits);
    const mine = refunds.find((r) => r.userId === DEMO.demoUserId)!;
    const exact = (st.unusedUnits * 600n) / 3000n;
    expect(mine.units === exact || mine.units === exact + 1n).toBe(true);
    expect(wallet(DEMO.demoUserId, 'USDC')).toBe(walletBefore + mine.units);
    expect(balanceOf(s(), acct.budget(C1), 'USDC')).toBe(0n);
    expect(s().miners['M-01'].windows[0].to).toBe(c.endedAt);
    expect(s().miners['M-01'].currentCampaignId).toBeUndefined();
  });

  it('11. ending a campaign preserves historical reward rights', () => {
    const before = myEnt(C1).creditedUnits;
    run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 24 * 3 });
    run(e, OP, 'reward.recordUnlock', { receiptId: airdropReceipt, amount: '500', externalRef: 'sim-unlock-0002' });
    expect(myEnt(C1).creditedUnits).toBe(before + flop('100'));
    // A late-arriving receipt for the old window still goes to Campaign 1.
    const c = s().campaigns[C1];
    const r = run(e, OP, 'reward.recordReceipt', { minerId: 'M-01', kind: 'session_payment', amount: '50', earnedFrom: c.startedAt, earnedTo: c.endedAt, externalRef: 'sim-session-late-01' });
    expect(r.lots.map((l: any) => l.campaignId)).toEqual([C1]);
    expect(myEnt(C1).creditedUnits).toBe(before + flop('110'));
  });

  it('12. later campaigns on the same miner do not dilute earlier rights', () => {
    const c1 = s().campaigns[C1]; // C1 is ended; its fields used below do not change
    const c1Credited = Object.fromEntries(c1.entitlementIds.map((id) => [id, s().entitlements[id].creditedUnits]));
    const gapStart = c1.endedAt!;
    run(e, DEMO_ACTOR, 'demo.fillFunding', { campaignId: C2 });
    expect(s().campaigns[C2].status).toBe('funded');
    run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 24 });
    run(e, OP, 'campaign.start', { campaignId: C2 });
    const c2 = () => s().campaigns[C2];
    expect(c2().minerId).toBe(c1.minerId);
    run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 24 * 4 });

    // Reward earned only inside Campaign 2's window goes only to Campaign 2.
    run(e, OP, 'reward.recordReceipt', { minerId: 'M-01', kind: 'block_reward', amount: '800', earnedFrom: c2().startedAt, earnedTo: s().clock, externalRef: 'sim-block-c2-01' });
    for (const [id, v] of Object.entries(c1Credited)) expect(s().entitlements[id].creditedUnits).toBe(v);
    expect(c2().rewards.receivedUnits).toBe(flop('800'));

    // A receipt spanning C1's window, the idle gap, and C2's window is split by time.
    const from = c1.startedAt!;
    const r = run(e, OP, 'reward.recordReceipt', { minerId: 'M-01', kind: 'other', amount: '1000', earnedFrom: from, earnedTo: s().clock, externalRef: 'sim-span-01' });
    const lots = r.lots as { campaignId: string | null; amountUnits: bigint }[];
    expect(lots.map((l) => l.campaignId).sort()).toEqual([C1, C2, null].sort() as any);
    expect(lots.reduce((t, l) => t + l.amountUnits, 0n)).toBe(flop('1000'));
    const unattributed = lots.find((l) => l.campaignId === null)!;
    expect(unattributed.amountUnits).toBeGreaterThan(0n); // idle gap belongs to nobody
    expect(balanceOf(s(), acct.unattributedUnlocked('M-01'), 'FLOP')).toBe(unattributed.amountUnits);
    expect(gapStart < c2().startedAt!).toBe(true);

    // Unlocking Campaign 1's historical airdrop during Campaign 2 credits Campaign 1.
    const c2Before = c2().rewards.creditedUnits;
    const c1DistBefore = s().campaigns[C1].rewards.distributableUnits;
    run(e, OP, 'reward.recordUnlock', { receiptId: airdropReceipt, amount: '1000', externalRef: 'sim-unlock-0003' });
    expect(c2().rewards.creditedUnits).toBe(c2Before);
    const c1Now = s().campaigns[C1];
    expect(c1Now.rewards.distributableUnits).toBe(c1DistBefore + flop('1000'));
    for (const id of c1Now.entitlementIds) {
      const ent = s().entitlements[id];
      expect(ent.creditedUnits).toBe(mulDivFloor(c1Now.rewards.distributableUnits, ent.shareNumerator, ent.shareDenominator));
    }
    // You hold nothing in Campaign 2, so you were credited nothing there.
    expect(Object.values(s().entitlements).some((x) => x.campaignId === C2 && x.holderId === DEMO.demoUserId)).toBe(false);
  });

  it('keeps every ledger invariant', () => {
    const bad = checkInvariants(s()).filter((x) => !x.ok);
    expect(bad).toEqual([]);
  });

  it('replaying the event log reproduces the exact state', () => {
    expect(encode(replay(e.log, DEMO.clockStart))).toBe(encode(s()));
  });
});

describe('other outcomes', () => {
  it('a funding deadline that passes refunds every contribution in full', () => {
    const e = seededEngine();
    run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 24 * 15 });
    const c = e.state.campaigns['C-001'];
    expect(c.status).toBe('funding_failed');
    expect(c.refundedUnits).toBe(usdc('2400'));
    expect(balanceOf(e.state, acct.wallet('u-avery'), 'USDC')).toBe(usdc('1000'));
    expect(e.state.campaigns['C-002'].status).toBe('funding');
    expectError(() => run(e, ME, 'contribution.submit', { campaignId: 'C-001', amount: '600' }), 'CAMPAIGN_NOT_OPEN');
  });

  it('cancelling before start refunds in full; a running campaign cannot be cancelled', () => {
    const e = seededEngine();
    run(e, OP, 'campaign.cancel', { campaignId: 'C-001', reason: 'Test' });
    expect(e.state.campaigns['C-001'].status).toBe('cancelled');
    expect(balanceOf(e.state, acct.budget('C-001'), 'USDC')).toBe(0n);
    const e2 = seededEngine();
    run(e2, ME, 'contribution.submit', { campaignId: 'C-001', amount: '600' });
    run(e2, OP, 'campaign.start', { campaignId: 'C-001' });
    expectError(() => run(e2, OP, 'campaign.cancel', { campaignId: 'C-001' }), 'INVALID_STATE');
  });

  it('a simulated provider outage exhausts automated attempts and opens an incident', () => {
    const e = seededEngine();
    run(e, ME, 'contribution.submit', { campaignId: 'C-001', amount: '600' });
    run(e, OP, 'campaign.start', { campaignId: 'C-001' });
    run(e, DEMO_ACTOR, 'demo.setMarketMode', { mode: 'deploy_outage' });
    const r = run(e, DEMO_ACTOR, 'demo.injectFailure', { campaignId: 'C-001' });
    expect(r.opsStatus).toBe('manual_intervention');
    const deps = e.state.campaigns['C-001'].ops.deploymentIds.map((id) => e.state.deployments[id]);
    expect(deps.filter((d) => d.status === 'deploy_failed').length).toBeGreaterThan(0);
    expect(deps.every((d) => d.status !== 'running')).toBe(true);
    // Operator picks an offer by hand once the market recovers.
    run(e, DEMO_ACTOR, 'demo.setMarketMode', { mode: 'normal' });
    expectError(() => run(e, OP, 'ops.retryRecovery', { campaignId: 'C-001', offerId: 'O-101' }), 'INVALID_INPUT');
    const ok = run(e, OP, 'ops.retryRecovery', { campaignId: 'C-001', offerId: 'O-107' });
    expect(ok.opsStatus).toBe('healthy');
  });

  it('distribution is path-independent: many small unlocks equal one large unlock', () => {
    const credits = (steps: string[]) => {
      const e = seededEngine();
      run(e, ME, 'contribution.submit', { campaignId: 'C-001', amount: '600' });
      run(e, OP, 'campaign.start', { campaignId: 'C-001' });
      run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 24 });
      const c = e.state.campaigns['C-001'];
      const r = run(e, OP, 'reward.recordReceipt', { minerId: 'M-01', kind: 'airdrop', amount: '7', liquidAmount: '0', earnedFrom: c.startedAt, earnedTo: e.state.clock, externalRef: 'sim-air-p' });
      steps.forEach((a, i) => run(e, OP, 'reward.recordUnlock', { receiptId: r.receiptId, amount: a, externalRef: `sim-u-${i}` }));
      return e.state.campaigns['C-001'].entitlementIds.map((id) => e.state.entitlements[id].creditedUnits);
    };
    const one = credits(['7']);
    const many = credits(['0.000000000000000001', '1.333333333333333333', '2', '3.666666666666666666']);
    expect(many).toEqual(one);
  });

  it('a simulated slash affects only the miner stake, not participant rewards', () => {
    const e = seededEngine();
    run(e, ME, 'contribution.submit', { campaignId: 'C-001', amount: '600' });
    run(e, OP, 'campaign.start', { campaignId: 'C-001' });
    run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 24 });
    const c = e.state.campaigns['C-001'];
    run(e, OP, 'reward.recordReceipt', { minerId: 'M-01', kind: 'block_reward', amount: '100', earnedFrom: c.startedAt, earnedTo: e.state.clock, externalRef: 'sim-b-1' });
    const ent = c.entitlementIds.map((id) => e.state.entitlements[id]).find((x) => x.holderId === DEMO.demoUserId)!;
    const before = balanceOf(e.state, acct.claimable(ent.id), 'FLOP');
    const r = run(e, DEMO_ACTOR, 'demo.simulateSlash', { minerId: 'M-01', amount: '2500', blacklist: false });
    expect(r.remainingStakeUnits).toBe(flop('7500'));
    expect(balanceOf(e.state, acct.claimable(ent.id), 'FLOP')).toBe(before);
    expect(e.state.campaigns['C-001'].ops.status).toBe('healthy'); // downtime ≠ fraud; a slash doesn't auto-fail ops
  });

  it('demo controls are refused when demo mode is off', () => {
    const e = seededEngine({ demoEnabled: false });
    expectError(() => run(e, DEMO_ACTOR, 'demo.advanceClock', { hours: 1 }), 'DEMO_DISABLED');
  });
});
