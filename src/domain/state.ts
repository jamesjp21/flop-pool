// The reducer: the only place where state changes. Commands emit events; events are
// applied here both live and when replaying the persisted log after a restart.
// Reducers must depend only on (state, event): no clocks, no adapters, no randomness.

import { isExternal } from './accounts';
import { DomainError } from './errors';
import type { Asset } from './money';
import { diffMs } from './time';
import type {
  Campaign,
  Claim,
  Contribution,
  Deployment,
  DistributionRecord,
  DomainEvent,
  Entitlement,
  Expenditure,
  Incident,
  MinerAccount,
  OfferEvaluation,
  OpsStatus,
  Posting,
  ProviderOffer,
  Refund,
  RewardLot,
  RewardReceipt,
  Settlement,
  State,
  UnlockRecord,
  User,
} from './types';

export function initialState(clock: string): State {
  return {
    schemaVersion: 1,
    seq: 0,
    clock,
    balances: {},
    postingCount: 0,
    users: {},
    miners: {},
    campaigns: {},
    contributions: {},
    entitlements: {},
    evaluations: {},
    deployments: {},
    incidents: {},
    expenditures: {},
    refunds: {},
    receipts: {},
    lots: {},
    unlocks: {},
    distributions: {},
    claims: {},
    externalRefs: {},
    idempotency: {},
    sim: { marketMode: 'normal', offers: {} },
  };
}

export function balanceOf(state: State, account: string, asset: Asset): bigint {
  return state.balances[account]?.[asset] ?? 0n;
}

function applyPostings(state: State, postings: Posting[] | undefined, ev: DomainEvent) {
  if (!postings) return;
  for (const p of postings) {
    if (p.amount <= 0n) throw new DomainError('LEDGER_INVARIANT', `Non-positive posting in ${ev.type}`);
    const fromBal = balanceOf(state, p.from, p.asset) - p.amount;
    if (fromBal < 0n && !isExternal(p.from)) {
      throw new DomainError('LEDGER_INVARIANT', `Posting would make ${p.from} negative (${p.asset}) in ${ev.type}`);
    }
    (state.balances[p.from] ??= {})[p.asset] = fromBal;
    (state.balances[p.to] ??= {})[p.asset] = balanceOf(state, p.to, p.asset) + p.amount;
    state.postingCount += 1;
  }
}

function campaign(state: State, id: string): Campaign {
  const c = state.campaigns[id];
  if (!c) throw new DomainError('LEDGER_INVARIANT', `Unknown campaign ${id} during apply`);
  return c;
}

function setOps(c: Campaign, status: OpsStatus) {
  c.ops.status = status;
}

type Reducer = (state: State, data: any, ev: DomainEvent) => void;

const reducers: Record<string, Reducer> = {
  'user.registered': (s, d: { user: User }) => {
    s.users[d.user.id] = d.user;
  },
  'wallet.topped_up': () => {},
  'miner.registered': (s, d: { miner: MinerAccount }) => {
    s.miners[d.miner.id] = d.miner;
  },
  'miner.stake_recorded': () => {},
  'miner.stake_slashed': (s, d: { minerId: string; units: bigint; blacklisted: boolean }) => {
    const m = s.miners[d.minerId];
    m.stake.slashedUnits += d.units;
    if (d.blacklisted) m.status = 'blacklisted';
  },
  'sim.offers_seeded': (s, d: { offers: ProviderOffer[] }) => {
    for (const o of d.offers) s.sim.offers[o.id] = o;
  },
  'sim.failure_injected': () => {},
  'sim.market_mode_set': (s, d: { mode: State['sim']['marketMode'] }) => {
    s.sim.marketMode = d.mode;
  },
  'clock.advanced': (s, d: { to: string }) => {
    s.clock = d.to;
  },
  'campaign.created': (s, d: { campaign: Campaign }) => {
    s.campaigns[d.campaign.id] = d.campaign;
  },
  'contribution.accepted': (s, d: { contribution: Contribution }) => {
    s.contributions[d.contribution.id] = d.contribution;
    const c = campaign(s, d.contribution.campaignId);
    c.fundedUnits += d.contribution.amountUnits;
    c.contributionIds.push(d.contribution.id);
  },
  'campaign.funding_closed': (s, d: { campaignId: string; entitlements: Entitlement[] }, ev) => {
    const c = campaign(s, d.campaignId);
    c.status = 'funded';
    c.fundingClosedAt = ev.at;
    for (const e of d.entitlements) {
      s.entitlements[e.id] = e;
      c.entitlementIds.push(e.id);
    }
  },
  'campaign.funding_failed': (s, d: { campaignId: string }, ev) => {
    const c = campaign(s, d.campaignId);
    c.status = 'funding_failed';
    c.cancelledAt = ev.at;
    c.closeReason = 'Funding deadline passed before the target was reached.';
  },
  'campaign.cancelled': (s, d: { campaignId: string; reason: string }, ev) => {
    const c = campaign(s, d.campaignId);
    c.status = 'cancelled';
    c.cancelledAt = ev.at;
    c.closeReason = d.reason;
    for (const id of c.entitlementIds) s.entitlements[id].status = 'void';
  },
  'campaign.started': (s, d: { campaignId: string; termEndsAt: string }, ev) => {
    const c = campaign(s, d.campaignId);
    c.status = 'running';
    c.startedAt = ev.at;
    c.termEndsAt = d.termEndsAt;
    setOps(c, 'provisioning');
    const m = s.miners[c.minerId];
    m.currentCampaignId = c.id;
    m.windows.push({ campaignId: c.id, from: ev.at });
  },
  'campaign.ended': (s, d: { campaignId: string; reason: string }, ev) => {
    const c = campaign(s, d.campaignId);
    c.status = 'ended';
    c.endedAt = ev.at;
    c.closeReason = d.reason;
    if (c.ops.downSince) {
      c.ops.downtimeMs += diffMs(ev.at, c.ops.downSince);
      c.ops.downSince = undefined;
    }
    setOps(c, 'stopped');
    const m = s.miners[c.minerId];
    if (m.currentCampaignId === c.id) m.currentCampaignId = undefined;
    const w = m.windows.find((x) => x.campaignId === c.id && !x.to);
    if (w) w.to = ev.at;
  },
  'campaign.settled': (s, d: { campaignId: string; settlement: Settlement }) => {
    campaign(s, d.campaignId).settlement = d.settlement;
  },
  'ops.status_changed': (s, d: { campaignId: string; status: OpsStatus }) => {
    setOps(campaign(s, d.campaignId), d.status);
  },
  'orchestrator.offers_evaluated': (s, d: { evaluation: OfferEvaluation }) => {
    s.evaluations[d.evaluation.id] = d.evaluation;
    campaign(s, d.evaluation.campaignId).ops.lastEvaluationId = d.evaluation.id;
  },
  'deployment.requested': (s, d: { deployment: Deployment }) => {
    s.deployments[d.deployment.id] = d.deployment;
    campaign(s, d.deployment.campaignId).ops.deploymentIds.push(d.deployment.id);
  },
  'deployment.running': (s, d: { deploymentId: string; instanceRef: string }, ev) => {
    const dep = s.deployments[d.deploymentId];
    const current = s.campaigns[dep.campaignId].ops.activeDeploymentId;
    if (current && current !== dep.id && s.deployments[current].status === 'running') {
      throw new DomainError('LEDGER_INVARIANT', `${dep.campaignId} would have two running machines (${current}, ${dep.id}).`);
    }
    dep.status = 'running';
    dep.runningAt = ev.at;
    dep.billedTo = ev.at;
    dep.instanceRef = d.instanceRef;
    const c = campaign(s, dep.campaignId);
    c.ops.activeDeploymentId = dep.id;
    if (c.ops.downSince) {
      c.ops.downtimeMs += diffMs(ev.at, c.ops.downSince);
      c.ops.downSince = undefined;
    }
    setOps(c, 'healthy');
  },
  'deployment.start_failed': (s, d: { deploymentId: string; kind: string; detail: string }, ev) => {
    const dep = s.deployments[d.deploymentId];
    dep.status = 'deploy_failed';
    dep.endedAt = ev.at;
    dep.failure = { kind: d.kind, detail: d.detail, at: ev.at };
    campaign(s, dep.campaignId).ops.excludedOffers.push({ offerId: dep.offer.id, reason: 'deploy_failed', at: ev.at });
  },
  'deployment.health_failed': (s, d: { deploymentId: string; kind: string; detail: string }, ev) => {
    const dep = s.deployments[d.deploymentId];
    dep.status = 'failed';
    dep.endedAt = ev.at;
    dep.failure = { kind: d.kind, detail: d.detail, at: ev.at };
    const c = campaign(s, dep.campaignId);
    if (c.ops.activeDeploymentId === dep.id) c.ops.activeDeploymentId = undefined;
    c.ops.downSince = ev.at;
    c.ops.excludedOffers.push({ offerId: dep.offer.id, reason: 'host_failed', at: ev.at });
    setOps(c, 'recovering');
  },
  'deployment.terminated': (s, d: { deploymentId: string }, ev) => {
    const dep = s.deployments[d.deploymentId];
    dep.status = 'terminated';
    dep.endedAt = ev.at;
    const c = campaign(s, dep.campaignId);
    if (c.ops.activeDeploymentId === dep.id) c.ops.activeDeploymentId = undefined;
  },
  'ops.exclusions_cleared': (s, d: { campaignId: string; reason: 'deploy_failed' }) => {
    const c = campaign(s, d.campaignId);
    c.ops.excludedOffers = c.ops.excludedOffers.filter((x) => x.reason !== d.reason);
  },
  'expenditure.recorded': (
    s,
    d: { expenditure: Expenditure; deployment: { billedTo?: string; rentalCostUnits: bigint; setupFeeUnits: bigint } },
  ) => {
    s.expenditures[d.expenditure.id] = d.expenditure;
    campaign(s, d.expenditure.campaignId).spentUnits += d.expenditure.units;
    const dep = s.deployments[d.expenditure.deploymentId];
    dep.billedTo = d.deployment.billedTo;
    dep.rentalCostUnits = d.deployment.rentalCostUnits;
    dep.setupFeeUnits = d.deployment.setupFeeUnits;
  },
  'incident.opened': (s, d: { incident: Incident }) => {
    s.incidents[d.incident.id] = d.incident;
    const c = campaign(s, d.incident.campaignId);
    c.ops.incidentIds.push(d.incident.id);
    c.ops.openIncidentIds.push(d.incident.id);
  },
  'incident.acknowledged': (s, d: { incidentId: string }, ev) => {
    const i = s.incidents[d.incidentId];
    i.status = 'acknowledged';
    i.acknowledgedAt = ev.at;
  },
  'incident.resolved': (s, d: { incidentId: string; note: string }, ev) => {
    const i = s.incidents[d.incidentId];
    i.status = 'resolved';
    i.resolvedAt = ev.at;
    i.resolutionNote = d.note;
    const c = campaign(s, i.campaignId);
    c.ops.openIncidentIds = c.ops.openIncidentIds.filter((x) => x !== i.id);
  },
  'refund.issued': (s, d: { refund: Refund; contributionIds?: string[] }) => {
    s.refunds[d.refund.id] = d.refund;
    const c = campaign(s, d.refund.campaignId);
    c.refundedUnits += d.refund.units;
    if (d.refund.entitlementId) s.entitlements[d.refund.entitlementId].refundedUsdcUnits += d.refund.units;
    for (const id of d.contributionIds ?? []) s.contributions[id].status = 'refunded_in_full';
  },
  'reward.receipt_recorded': (s, d: { receipt: RewardReceipt; lots: RewardLot[] }) => {
    s.receipts[d.receipt.id] = d.receipt;
    s.externalRefs[`receipt:${d.receipt.externalRef.toLowerCase()}`] = d.receipt.id;
    for (const lot of d.lots) {
      s.lots[lot.id] = lot;
      if (lot.campaignId) {
        const r = campaign(s, lot.campaignId).rewards;
        r.receivedUnits += lot.amountUnits;
        r.liquidAtReceiptUnits += lot.liquidUnits;
        r.lockedRemainingUnits += lot.lockedUnits;
        r.distributableUnits += lot.liquidUnits;
        r.lotIds.push(lot.id);
      }
    }
  },
  'reward.unlocked': (s, d: { unlock: UnlockRecord }) => {
    s.unlocks[d.unlock.id] = d.unlock;
    s.externalRefs[`unlock:${d.unlock.externalRef.toLowerCase()}`] = d.unlock.id;
    s.receipts[d.unlock.receiptId].unlockedUnits += d.unlock.amountUnits;
    for (const p of d.unlock.perLot) {
      s.lots[p.lotId].lockedRemainingUnits -= p.units;
      if (p.campaignId) {
        const r = campaign(s, p.campaignId).rewards;
        r.lockedRemainingUnits -= p.units;
        r.distributableUnits += p.units;
      }
    }
  },
  'reward.distributed': (s, d: { distribution: DistributionRecord }) => {
    s.distributions[d.distribution.id] = d.distribution;
    const c = campaign(s, d.distribution.campaignId);
    for (const cr of d.distribution.credits) {
      s.entitlements[cr.entitlementId].creditedUnits += cr.units;
      c.rewards.creditedUnits += cr.units;
    }
  },
  'claim.paid': (s, d: { claim: Claim }) => {
    s.claims[d.claim.id] = d.claim;
    s.entitlements[d.claim.entitlementId].claimedUnits += d.claim.units;
    campaign(s, d.claim.campaignId).rewards.claimedUnits += d.claim.units;
  },
  'command.completed': (s, d: { key: string; commandType: string; actor: string; request: string; result: unknown }, ev) => {
    s.idempotency[d.key] = { key: d.key, commandType: d.commandType, actor: d.actor, request: d.request, result: d.result, seq: ev.seq };
  },
};

export const EVENT_TYPES = Object.keys(reducers);

export function applyEvent(state: State, ev: DomainEvent): void {
  if (ev.seq !== state.seq + 1) {
    throw new DomainError('LEDGER_INVARIANT', `Event sequence gap: expected ${state.seq + 1}, got ${ev.seq}`);
  }
  const reducer = reducers[ev.type];
  if (!reducer) throw new DomainError('LEDGER_INVARIANT', `Unknown event type ${ev.type}`);
  applyPostings(state, ev.postings, ev);
  // Reducers get a private copy: state must never alias event payloads, or later
  // mutations would rewrite history (and break replay).
  reducer(state, structuredClone(ev.data), ev);
  state.seq = ev.seq;
}

export function replay(events: DomainEvent[], clock: string): State {
  const s = initialState(clock);
  for (const ev of events) applyEvent(s, ev);
  return s;
}
