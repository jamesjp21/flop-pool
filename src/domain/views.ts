// Read models. Pure functions of state (plus the event list for the audit view).
// Both the HTTP server and the in-browser preview serve exactly these.

import { acct, isExternal } from './accounts';
import { ALLOCATION_RULE_TEXT, DEMO, ORCHESTRATION, PROTOCOL_ASSUMPTIONS, REFUND_RULES } from './config';
import { campaignIdOf, describeEvent } from './describe';
import { FEE_OPEN_QUESTIONS } from './fees';
import { mulDivFloor, percentString } from './money';
import { evaluateOffers } from './providers/selection';
import { realProviderStatus } from './providers/simulated';
import { balanceOf } from './state';
import { diffMs } from './time';
import type { Campaign, DomainEvent, Entitlement, OpsStatus, State } from './types';

export const STATUS_LABEL: Record<Campaign['status'], string> = {
  funding: 'Open for funding',
  funded: 'Fully funded · awaiting start',
  running: 'Operating',
  ended: 'Ended · rewards rights continue',
  cancelled: 'Cancelled · refunded',
  funding_failed: 'Funding failed · refunded',
};

export const OPS_LABEL: Record<OpsStatus, string> = {
  not_started: 'Not started',
  provisioning: 'Provisioning',
  healthy: 'Miner healthy',
  recovering: 'Recovering',
  manual_intervention: 'Needs operator',
  stopped: 'Stopped',
};

function walletOf(s: State, userId: string) {
  return { usdcUnits: balanceOf(s, acct.wallet(userId), 'USDC'), flopUnits: balanceOf(s, acct.wallet(userId), 'FLOP') };
}

function userLabel(s: State, userId: string, viewerId?: string) {
  if (userId === viewerId) return 'You';
  return s.users[userId]?.displayName ?? userId;
}

function contributedBy(s: State, c: Campaign, userId: string) {
  return c.contributionIds.map((id) => s.contributions[id]).filter((x) => x.userId === userId);
}

function entitlementOf(s: State, c: Campaign, userId: string): Entitlement | undefined {
  return c.entitlementIds.map((id) => s.entitlements[id]).find((e) => e.holderId === userId);
}

function share(units: bigint, e: Entitlement) {
  return mulDivFloor(units, e.shareNumerator, e.shareDenominator);
}

function campaignCard(s: State, c: Campaign, viewerId?: string) {
  const mine = viewerId ? contributedBy(s, c, viewerId) : [];
  const myUnits = mine.reduce((t, x) => t + x.amountUnits, 0n);
  const ent = viewerId ? entitlementOf(s, c, viewerId) : undefined;
  const contributors = new Set(c.contributionIds.map((id) => s.contributions[id].userId)).size;
  return {
    id: c.id,
    name: c.name,
    summary: c.summary,
    minerId: c.minerId,
    status: c.status,
    statusLabel: STATUS_LABEL[c.status],
    opsStatus: c.ops.status,
    opsLabel: OPS_LABEL[c.ops.status],
    targetUnits: c.terms.targetUnits,
    fundedUnits: c.fundedUnits,
    remainingUnits: c.terms.targetUnits - c.fundedUnits,
    fundedPercent: percentString(c.fundedUnits, c.terms.targetUnits, 1),
    minContributionUnits: c.terms.minContributionUnits,
    fundingDeadline: c.terms.fundingDeadline,
    termDays: c.terms.termDays,
    startedAt: c.startedAt,
    termEndsAt: c.termEndsAt,
    endedAt: c.endedAt,
    contributorCount: contributors,
    openIncidents: c.ops.openIncidentIds.length,
    my: viewerId
      ? {
          contributedUnits: myUnits,
          allocationPercent: ent ? percentString(ent.shareNumerator, ent.shareDenominator, 4) : myUnits > 0n ? percentString(myUnits, c.fundedUnits, 4) : undefined,
          allocationFrozen: Boolean(ent),
        }
      : undefined,
  };
}

export type CampaignCard = ReturnType<typeof campaignCard>;

export function viewHome(s: State, viewerId: string) {
  const campaigns = Object.values(s.campaigns).map((c) => campaignCard(s, c, viewerId));
  const ents = Object.values(s.entitlements).filter((e) => e.holderId === viewerId && e.status === 'active');
  return {
    clock: s.clock,
    viewerId,
    viewerName: s.users[viewerId]?.displayName ?? viewerId,
    wallet: walletOf(s, viewerId),
    campaigns,
    claimableUnits: ents.reduce((t, e) => t + balanceOf(s, acct.claimable(e.id), 'FLOP'), 0n),
    journey: viewJourney(s),
  };
}

export function viewCampaign(s: State, campaignId: string, viewerId: string) {
  const c = s.campaigns[campaignId];
  if (!c) return null;
  const miner = s.miners[c.minerId];
  const wallet = walletOf(s, viewerId);
  const remaining = c.terms.targetUnits - c.fundedUnits;
  const open = c.status === 'funding' && diffMs(c.terms.fundingDeadline, s.clock) > 0;
  const byUser = new Map<string, bigint>();
  for (const id of c.contributionIds) {
    const ct = s.contributions[id];
    byUser.set(ct.userId, (byUser.get(ct.userId) ?? 0n) + ct.amountUnits);
  }
  const ent = entitlementOf(s, c, viewerId);
  const myContribs = contributedBy(s, c, viewerId);
  const active = c.ops.activeDeploymentId ? s.deployments[c.ops.activeDeploymentId] : undefined;
  const spentByKind = { gpu_rental: 0n, setup_fee: 0n };
  for (const x of Object.values(s.expenditures)) if (x.campaignId === c.id) spentByKind[x.kind] += x.units;
  return {
    clock: s.clock,
    card: campaignCard(s, c, viewerId),
    terms: {
      ...c.terms,
      refundRules: REFUND_RULES,
      allocationRuleText: ALLOCATION_RULE_TEXT,
    },
    miner: {
      id: miner.id,
      label: miner.label,
      tier: miner.tier,
      status: miner.status,
      stakeRequiredUnits: miner.stake.requiredBaseUnits,
      stakeRecordedUnits: balanceOf(s, acct.stake(miner.id), 'FLOP'),
      stakeSupplier: miner.stake.supplier,
      stakeNote: miner.stake.supplierNote,
      bondNote: miner.stake.bondNote,
      reusedByCampaigns: Object.values(s.campaigns).filter((x) => x.minerId === miner.id).map((x) => x.id),
    },
    funding: {
      open,
      remainingUnits: remaining,
      closedAt: c.fundingClosedAt,
      maxContributionUnits: open ? (remaining < wallet.usdcUnits ? remaining : wallet.usdcUnits) : 0n,
      closingContributionAllowed: remaining > 0n && remaining < c.terms.minContributionUnits,
      contributors: [...byUser.entries()].map(([userId, units]) => {
        const e = entitlementOf(s, c, userId);
        return {
          label: userLabel(s, userId, viewerId),
          isViewer: userId === viewerId,
          units,
          percent: e ? percentString(e.shareNumerator, e.shareDenominator, 2) : percentString(units, c.fundedUnits || 1n, 2),
          frozen: Boolean(e),
        };
      }),
    },
    viewer: {
      wallet,
      contributedUnits: myContribs.reduce((t, x) => t + x.amountUnits, 0n),
      contributions: myContribs.map((x) => ({ id: x.id, units: x.amountUnits, at: x.at, status: x.status })),
      entitlement: ent
        ? {
            id: ent.id,
            percent: percentString(ent.shareNumerator, ent.shareDenominator, 4),
            shareNumerator: ent.shareNumerator,
            shareDenominator: ent.shareDenominator,
            frozenAt: ent.frozenAt,
            status: ent.status,
            claimableUnits: balanceOf(s, acct.claimable(ent.id), 'FLOP'),
          }
        : undefined,
    },
    ops: {
      status: c.ops.status,
      label: OPS_LABEL[c.ops.status],
      machine: active
        ? { deploymentId: active.id, gpuModel: active.offer.gpuModel, vramGb: active.offer.vramGb, provider: active.offer.providerLabel, region: active.offer.region, hourlyUnits: active.offer.hourlyUnits, since: active.runningAt }
        : undefined,
      deployments: c.ops.deploymentIds.length,
      replacements: c.ops.deploymentIds.filter((id) => s.deployments[id].purpose !== 'initial' && s.deployments[id].status !== 'deploy_failed').length,
      downtimeMs: c.ops.downtimeMs + (c.ops.downSince ? diffMs(s.clock, c.ops.downSince) : 0),
      openIncidents: c.ops.openIncidentIds.length,
    },
    budget: {
      fundedUnits: c.fundedUnits,
      spentUnits: c.spentUnits,
      spentByKind,
      remainingUnits: balanceOf(s, acct.budget(c.id), 'USDC'),
      refundedUnits: c.refundedUnits,
      settlement: c.settlement,
    },
    rewards: {
      ...c.rewards,
      residualUnits: balanceOf(s, acct.rewardsUndistributed(c.id), 'FLOP'),
    },
    protocol: PROTOCOL_ASSUMPTIONS,
    feeOpenQuestions: FEE_OPEN_QUESTIONS,
  };
}

export function viewPortfolio(s: State, viewerId: string) {
  const positions = Object.values(s.campaigns)
    .filter((c) => c.contributionIds.some((id) => s.contributions[id].userId === viewerId) || entitlementOf(s, c, viewerId))
    .map((c) => {
      const contribs = contributedBy(s, c, viewerId);
      const contributed = contribs.reduce((t, x) => t + x.amountUnits, 0n);
      const e = entitlementOf(s, c, viewerId);
      const refunds = Object.values(s.refunds).filter((r) => r.campaignId === c.id && r.userId === viewerId);
      const refunded = refunds.reduce((t, r) => t + r.units, 0n);
      let spentShare: bigint;
      let spentBasis: 'final' | 'to_date' | 'none';
      if (c.settlement) {
        spentShare = contributed - refunded;
        spentBasis = 'final';
      } else if (e) {
        spentShare = share(c.spentUnits, e);
        spentBasis = 'to_date';
      } else {
        spentShare = 0n;
        spentBasis = 'none';
      }
      const claimable = e ? balanceOf(s, acct.claimable(e.id), 'FLOP') : 0n;
      return {
        campaign: campaignCard(s, c, viewerId),
        state: (c.status === 'cancelled' || c.status === 'funding_failed' ? 'refunded' : e ? 'allocated' : 'pending_funding') as 'refunded' | 'allocated' | 'pending_funding',
        contributedUnits: contributed,
        contributions: contribs.map((x) => ({ id: x.id, units: x.amountUnits, at: x.at, status: x.status })),
        entitlement: e
          ? {
              id: e.id,
              percent: percentString(e.shareNumerator, e.shareDenominator, 4),
              shareNumerator: e.shareNumerator,
              shareDenominator: e.shareDenominator,
              frozenAt: e.frozenAt,
              status: e.status,
              ownership: e.ownership.map((o) => ({ ...o, label: userLabel(s, o.holderId, viewerId) })),
            }
          : undefined,
        provisionalPercent: !e && contributed > 0n && c.fundedUnits > 0n ? percentString(contributed, c.fundedUnits, 4) : undefined,
        money: { contributedUnits: contributed, spentShareUnits: spentShare, spentBasis, refundedUnits: refunded },
        rewards: {
          campaignReceivedUnits: c.rewards.receivedUnits,
          campaignLockedUnits: c.rewards.lockedRemainingUnits,
          attributableReceivedUnits: e ? share(c.rewards.receivedUnits, e) : 0n,
          lockedShareUnits: e ? share(c.rewards.lockedRemainingUnits, e) : 0n,
          creditedUnits: e?.creditedUnits ?? 0n,
          claimableUnits: claimable,
          claimedUnits: e?.claimedUnits ?? 0n,
        },
      };
    });

  const myEnts = new Map(Object.values(s.entitlements).filter((e) => e.holderId === viewerId).map((e) => [e.id, e]));
  type Item = { at: string; order: number; kind: 'receipt' | 'unlock' | 'credit' | 'claim'; campaignId: string; title: string; detail: string; units?: bigint; lockedUnits?: bigint };
  const history: Item[] = [];
  for (const r of Object.values(s.receipts)) {
    for (const lotId of r.lotIds) {
      const lot = s.lots[lotId];
      if (!lot.campaignId) continue;
      const e = [...myEnts.values()].find((x) => x.campaignId === lot.campaignId);
      if (!e) continue;
      history.push({
        at: r.recordedAt,
        order: 1,
        kind: 'receipt',
        campaignId: lot.campaignId,
        title: `Campaign received a ${r.kind.replace('_', ' ')}`,
        detail: `${r.id} · earned ${r.earnedFrom.slice(0, 10)} → ${r.earnedTo.slice(0, 10)} · ref ${r.externalRef}`,
        units: share(lot.amountUnits, e),
        lockedUnits: lot.lockedUnits > 0n ? share(lot.lockedUnits, e) : undefined,
      });
    }
  }
  for (const u of Object.values(s.unlocks)) {
    for (const p of u.perLot) {
      if (!p.campaignId) continue;
      const e = [...myEnts.values()].find((x) => x.campaignId === p.campaignId);
      if (!e) continue;
      history.push({ at: u.at, order: 2, kind: 'unlock', campaignId: p.campaignId, title: 'Locked rewards unlocked', detail: `${u.id} on ${u.receiptId} · ref ${u.externalRef}`, units: share(p.units, e) });
    }
  }
  for (const d of Object.values(s.distributions)) {
    for (const cr of d.credits) {
      if (!myEnts.has(cr.entitlementId)) continue;
      history.push({ at: d.at, order: 3, kind: 'credit', campaignId: d.campaignId, title: 'Credited to your claimable balance', detail: `${d.id} from ${d.trigger.kind} ${d.trigger.ref}`, units: cr.units });
    }
  }
  for (const cl of Object.values(s.claims)) {
    if (cl.holderId !== viewerId) continue;
    history.push({ at: cl.at, order: 4, kind: 'claim', campaignId: cl.campaignId, title: 'Claimed to your wallet', detail: `${cl.id} · simulated transfer ${cl.simulatedTxRef}`, units: cl.units });
  }
  history.sort((a, b) => (a.at === b.at ? b.order - a.order : a.at < b.at ? 1 : -1));

  return {
    clock: s.clock,
    viewerId,
    wallet: walletOf(s, viewerId),
    positions,
    history,
    refunds: Object.values(s.refunds).filter((r) => r.userId === viewerId),
  };
}

export function viewOperator(s: State, env: Record<string, string | undefined> = {}) {
  const campaigns = Object.values(s.campaigns).map((c) => {
    const preview =
      c.status === 'running' || c.status === 'funded'
        ? evaluateOffers({
            offers: Object.values(s.sim.offers).map((o) => ({ ...o, available: s.sim.marketMode === 'no_capacity' ? false : o.available })),
            requirements: c.terms.hardware,
            budgetUnits: balanceOf(s, acct.budget(c.id), 'USDC'),
            now: s.clock,
            termEndsAt: c.termEndsAt ?? new Date(Date.parse(s.clock) + c.terms.termDays * 86_400_000).toISOString(),
            excluded: c.ops.excludedOffers,
          })
        : undefined;
    return {
      card: campaignCard(s, c),
      terms: c.terms,
      ops: { ...c.ops, label: OPS_LABEL[c.ops.status], downtimeMs: c.ops.downtimeMs + (c.ops.downSince ? diffMs(s.clock, c.ops.downSince) : 0) },
      budgetRemainingUnits: balanceOf(s, acct.budget(c.id), 'USDC'),
      spentUnits: c.spentUnits,
      refundedUnits: c.refundedUnits,
      settlement: c.settlement,
      rewards: { ...c.rewards, residualUnits: balanceOf(s, acct.rewardsUndistributed(c.id), 'FLOP') },
      actions: {
        canStart: c.status === 'funded',
        canEnd: c.status === 'running',
        canCancel: c.status === 'funding' || c.status === 'funded',
        canRetry: c.status === 'running' && c.ops.status === 'manual_intervention' && s.miners[c.minerId].status !== 'blacklisted',
        canFail: c.status === 'running' && c.ops.status === 'healthy',
        canFill: c.status === 'funding',
      },
      contributions: c.contributionIds.map((id) => {
        const x = s.contributions[id];
        return { ...x, label: userLabel(s, x.userId) };
      }),
      entitlements: c.entitlementIds.map((id) => {
        const e = s.entitlements[id];
        return {
          id: e.id,
          holderLabel: userLabel(s, e.holderId),
          holderId: e.holderId,
          contributedUnits: e.contributedUnits,
          percent: percentString(e.shareNumerator, e.shareDenominator, 4),
          status: e.status,
          creditedUnits: e.creditedUnits,
          claimedUnits: e.claimedUnits,
          claimableUnits: balanceOf(s, acct.claimable(e.id), 'FLOP'),
          refundedUsdcUnits: e.refundedUsdcUnits,
        };
      }),
      deployments: c.ops.deploymentIds.map((id) => s.deployments[id]),
      lastEvaluation: c.ops.lastEvaluationId ? s.evaluations[c.ops.lastEvaluationId] : undefined,
      marketPreview: preview,
      incidents: c.ops.incidentIds.map((id) => s.incidents[id]),
      expenditures: Object.values(s.expenditures).filter((x) => x.campaignId === c.id),
      refunds: Object.values(s.refunds).filter((r) => r.campaignId === c.id).map((r) => ({ ...r, label: userLabel(s, r.userId) })),
    };
  });
  return {
    clock: s.clock,
    marketMode: s.sim.marketMode,
    offers: Object.values(s.sim.offers),
    campaigns,
    incidents: Object.values(s.incidents).sort((a, b) => (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0) || (a.id < b.id ? 1 : -1)),
    miners: Object.values(s.miners).map((m) => ({
      ...m,
      stakeBalanceUnits: balanceOf(s, acct.stake(m.id), 'FLOP'),
      unattributedLockedUnits: balanceOf(s, acct.unattributedLocked(m.id), 'FLOP'),
      unattributedUnlockedUnits: balanceOf(s, acct.unattributedUnlocked(m.id), 'FLOP'),
    })),
    receipts: Object.values(s.receipts)
      .map((r) => ({ ...r, lots: r.lotIds.map((id) => s.lots[id]), unlocks: Object.values(s.unlocks).filter((u) => u.receiptId === r.id) }))
      .reverse(),
    users: Object.values(s.users),
    adapters: [{ id: 'simulated', label: 'Simulated provider adapter', implemented: true, configured: true, credentialEnv: '—' }, ...realProviderStatus(env).map((a) => ({ ...a }))],
    orchestration: ORCHESTRATION,
    protocol: PROTOCOL_ASSUMPTIONS,
    feeOpenQuestions: FEE_OPEN_QUESTIONS,
    invariants: checkInvariants(s),
  };
}

export function checkInvariants(s: State) {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  const totals: Record<string, bigint> = { USDC: 0n, FLOP: 0n };
  let negatives = 0;
  for (const [account, bal] of Object.entries(s.balances)) {
    for (const [asset, v] of Object.entries(bal)) {
      totals[asset] += v as bigint;
      if ((v as bigint) < 0n && !isExternal(account)) negatives++;
    }
  }
  out.push({ name: 'Double entry balances to zero', ok: totals.USDC === 0n && totals.FLOP === 0n, detail: `USDC Σ=${totals.USDC}, FLOP Σ=${totals.FLOP}` });
  out.push({ name: 'No internal account is negative', ok: negatives === 0, detail: `${negatives} negative internal balances` });
  for (const c of Object.values(s.campaigns)) {
    const budget = balanceOf(s, acct.budget(c.id), 'USDC');
    const fee = c.settlement?.fee.usdcUnits ?? 0n;
    out.push({ name: `${c.id} budget = funded − spent − refunded − fee`, ok: budget === c.fundedUnits - c.spentUnits - c.refundedUnits - fee, detail: `budget ${budget}` });
    const running = c.ops.deploymentIds.filter((id) => s.deployments[id].status === 'running').length;
    out.push({ name: `${c.id} runs at most one machine (none once closed)`, ok: c.status === 'running' ? running <= 1 : running === 0, detail: `${running} running` });
    const locked = balanceOf(s, acct.rewardsLocked(c.id), 'FLOP');
    const undistributed = balanceOf(s, acct.rewardsUndistributed(c.id), 'FLOP');
    out.push({ name: `${c.id} locked rewards match lots`, ok: locked === c.rewards.lockedRemainingUnits, detail: `ledger ${locked}` });
    out.push({ name: `${c.id} undistributed = distributable − credited`, ok: undistributed === c.rewards.distributableUnits - c.rewards.creditedUnits, detail: `residual ${undistributed}` });
    const ents = c.entitlementIds.map((id) => s.entitlements[id]);
    const claimableSum = ents.reduce((t, e) => t + balanceOf(s, acct.claimable(e.id), 'FLOP'), 0n);
    out.push({ name: `${c.id} claimable = credited − claimed`, ok: claimableSum === c.rewards.creditedUnits - c.rewards.claimedUnits && ents.every((e) => balanceOf(s, acct.claimable(e.id), 'FLOP') === e.creditedUnits - e.claimedUnits), detail: `claimable ${claimableSum}` });
    if (ents.length) {
      const num = ents.reduce((t, e) => t + e.shareNumerator, 0n);
      out.push({ name: `${c.id} frozen allocations sum to 100%`, ok: ents.every((e) => e.shareDenominator === c.fundedUnits) && num === c.fundedUnits, detail: `${num}/${c.fundedUnits}` });
    }
  }
  for (const r of Object.values(s.receipts)) {
    const lots = r.lotIds.map((id) => s.lots[id]);
    out.push({ name: `${r.id} lots sum to receipt`, ok: lots.reduce((t, l) => t + l.amountUnits, 0n) === r.amountUnits && lots.reduce((t, l) => t + l.lockedUnits, 0n) === r.lockedUnits, detail: `${lots.length} lot(s)` });
  }
  return out;
}

export function viewLedger(s: State) {
  const accounts = Object.entries(s.balances)
    .map(([account, bal]) => ({ account, external: isExternal(account), usdcUnits: bal.USDC ?? 0n, flopUnits: bal.FLOP ?? 0n }))
    .sort((a, b) => (a.account < b.account ? -1 : 1));
  return { clock: s.clock, accounts, postingCount: s.postingCount, invariants: checkInvariants(s) };
}

export function viewAudit(events: DomainEvent[], opts: { campaignId?: string; limit?: number; includeCommands?: boolean } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const rows = [];
  for (let i = events.length - 1; i >= 0 && rows.length < limit; i--) {
    const ev = events[i];
    if (!opts.includeCommands && ev.type === 'command.completed') continue;
    const cid = campaignIdOf(ev);
    if (opts.campaignId && cid !== opts.campaignId) continue;
    rows.push({
      seq: ev.seq,
      id: ev.id,
      type: ev.type,
      at: ev.at,
      recordedAt: ev.recordedAt,
      actor: ev.actor,
      actorKind: ev.actorKind,
      commandId: ev.commandId,
      campaignId: cid,
      summary: describeEvent(ev),
      postings: (ev.postings ?? []).map((p) => ({ ...p })),
    });
  }
  return { total: events.length, rows };
}

export function viewJourney(s: State) {
  const c1 = s.campaigns['C-001'];
  const c2 = s.campaigns['C-002'];
  const deps = c1 ? c1.ops.deploymentIds.map((id) => s.deployments[id]) : [];
  const firstFailure = deps.findIndex((d) => d.status === 'failed');
  const replaced = firstFailure >= 0 && deps.slice(firstFailure + 1).some((d) => d.runningAt);
  const demo = DEMO.demoUserId;
  const steps = [
    { key: 'contribute', role: 'participant', title: 'Contribute to Campaign 1', hint: 'Open Campaign 1 and contribute the remaining 600 USDC (or part of it).', done: Boolean(c1?.contributionIds.some((id) => s.contributions[id].userId === demo)) },
    { key: 'freeze', role: 'participant', title: 'Funding completes and allocations freeze', hint: 'Reaching the 3,000 USDC target closes funding automatically.', done: Boolean(c1?.fundingClosedAt) },
    { key: 'start', role: 'operator', title: 'Start the funded campaign', hint: 'Operator console → Start campaign. The orchestrator picks an eligible offer.', done: Boolean(c1?.startedAt) },
    { key: 'replace', role: 'operator', title: 'Simulate a machine failure; automation replaces it', hint: 'Demo controls → Simulate machine failure.', done: replaced },
    { key: 'incident', role: 'operator', title: 'Exhaust replacements; an operator incident opens', hint: 'Fail the replacement too. No eligible offers remain, so an incident opens.', done: Boolean(c1?.ops.incidentIds.length) },
    { key: 'receipt', role: 'operator', title: 'Record a reward receipt', hint: 'Rewards → Record receipt (try an airdrop: 75% arrives locked).', done: Boolean(c1?.rewards.lotIds.length) },
    { key: 'claim', role: 'participant', title: 'Unlock rewards, then claim your share', hint: 'Locked FLOP cannot be claimed. Record an unlock, then claim from My positions.', done: Object.values(s.claims).some((x) => x.holderId === demo) },
    { key: 'end', role: 'operator', title: 'End Campaign 1; unused budget is refunded', hint: 'Spent and unused money are reported separately.', done: Boolean(c1?.settlement && c1.status === 'ended') },
    { key: 'later', role: 'operator', title: 'Run Campaign 2 on the same miner', hint: 'Fill and start Campaign 2, then record rewards and unlocks. Campaign 1 shares stay intact.', done: Boolean(c2?.rewards.lotIds.length) },
  ];
  return { steps, completed: steps.filter((x) => x.done).length };
}
