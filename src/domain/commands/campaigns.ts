import { acct } from '../accounts';
import { ALLOCATION_RULE_TEXT } from '../config';
import { SERVICE_ACTORS, type CommandDef, type Tx } from '../engine';
import { DomainError } from '../errors';
import { computeSettlementFee } from '../fees';
import { apportion, formatAmount, parsePositiveAmount, percentString } from '../money';
import { balanceOf } from '../state';
import { addDays, isBefore, isValidIso, normalizeIso } from '../time';
import type { Campaign, CostLine, Entitlement, HardwareRequirements, Refund, State } from '../types';
import { accrueDeployment, provision } from './orchestrator';

export function requireCampaign(state: State, id: unknown): Campaign {
  const c = typeof id === 'string' ? state.campaigns[id] : undefined;
  if (!c) throw new DomainError('NOT_FOUND', `Campaign ${String(id)} was not found.`);
  return c;
}

// ---------------- Creation ----------------

export interface CreateCampaignInput {
  name: string;
  summary?: string;
  minerId: string;
  target: string;
  minContribution: string;
  fundingDays?: number;
  fundingDeadline?: string;
  termDays: number;
  minVramGb?: number;
  costLines?: { key: string; label: string; amount: string; note: string }[];
}

export const DEFAULT_HARDWARE: HardwareRequirements = {
  tier: 'SOFT',
  minVramGb: 80,
  minReliabilityBps: 9700,
  allowInterruptible: false,
  requireVerifiedHost: true,
  description: '1 GPU with at least 80 GB VRAM, on-demand, verified host, 97%+ reliability (illustrative campaign spec)',
};

function defaultCostLines(target: bigint, termDays: number): CostLine[] {
  const parts = apportion(target, [
    { key: 'gpu_rental', weight: 84n, tiebreak: '1' },
    { key: 'replacement_reserve', weight: 10n, tiebreak: '2' },
    { key: 'deployment_ops', weight: 6n, tiebreak: '3' },
  ]);
  return [
    { key: 'gpu_rental', label: `GPU rental, ${termDays} days`, units: parts.get('gpu_rental')!, note: 'Budget ceiling for the machine itself, at simulated offer prices.' },
    { key: 'replacement_reserve', label: 'Replacement and overlap reserve', units: parts.get('replacement_reserve')!, note: 'Covers a pricier replacement if a machine fails.' },
    { key: 'deployment_ops', label: 'Deployment, storage and bandwidth', units: parts.get('deployment_ops')!, note: 'Per-deployment setup fees and transfer (estimate).' },
    { key: 'platform_fee', label: 'Platform fee', units: 0n, note: 'Not configured. The fee model is still undecided.' },
  ];
}

export function createCampaign(tx: Tx, input: CreateCampaignInput): Campaign {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 3 || name.length > 80) throw new DomainError('INVALID_INPUT', 'Campaign name must be 3–80 characters.');
  const miner = tx.state.miners[input.minerId];
  if (!miner) throw new DomainError('NOT_FOUND', `Miner account ${input.minerId} was not found.`);
  const target = parsePositiveAmount(input.target, 'USDC', 'funding target');
  const min = parsePositiveAmount(input.minContribution, 'USDC', 'minimum contribution');
  if (min > target) throw new DomainError('INVALID_INPUT', 'Minimum contribution cannot exceed the funding target.');
  const termDays = Number(input.termDays);
  if (!Number.isInteger(termDays) || termDays < 1 || termDays > 365) throw new DomainError('INVALID_INPUT', 'Term must be 1–365 whole days.');
  let deadline: string;
  if (input.fundingDeadline !== undefined) {
    if (!isValidIso(input.fundingDeadline)) throw new DomainError('INVALID_INPUT', 'Funding deadline must be an ISO timestamp.');
    deadline = normalizeIso(input.fundingDeadline);
  } else {
    const days = Number(input.fundingDays ?? 14);
    if (!Number.isInteger(days) || days < 1 || days > 120) throw new DomainError('INVALID_INPUT', 'Funding window must be 1–120 whole days.');
    deadline = addDays(tx.now, days);
  }
  if (!isBefore(tx.now, deadline)) throw new DomainError('INVALID_INPUT', 'Funding deadline must be in the future.');
  const minVram = input.minVramGb === undefined ? DEFAULT_HARDWARE.minVramGb : Number(input.minVramGb);
  if (!Number.isInteger(minVram) || minVram < 8 || minVram > 640) throw new DomainError('INVALID_INPUT', 'Minimum VRAM must be 8–640 GB.');
  const costLines = input.costLines
    ? input.costLines.map((l) => ({ key: l.key, label: l.label, note: l.note, units: l.key === 'platform_fee' ? 0n : parsePositiveAmount(l.amount, 'USDC', l.label) }))
    : defaultCostLines(target, termDays);
  const total = costLines.reduce((s, l) => s + l.units, 0n);
  if (total !== target) throw new DomainError('INVALID_INPUT', 'Cost breakdown must add up exactly to the funding target.');

  const id = tx.nextId('C', tx.state.campaigns);
  const campaign: Campaign = {
    id,
    name,
    summary: (input.summary ?? '').trim(),
    minerId: miner.id,
    status: 'funding',
    terms: {
      targetUnits: target,
      minContributionUnits: min,
      fundingOpensAt: tx.now,
      fundingDeadline: deadline,
      termDays,
      allocationRule: 'pro_rata_contribution_v1',
      costLines,
      hardware: { ...DEFAULT_HARDWARE, minVramGb: minVram, description: DEFAULT_HARDWARE.description.replace('80 GB', `${minVram} GB`) },
      feeModel: { kind: 'unconfigured' },
    },
    fundedUnits: 0n,
    contributionIds: [],
    entitlementIds: [],
    createdAt: tx.now,
    ops: { status: 'not_started', deploymentIds: [], excludedOffers: [], openIncidentIds: [], incidentIds: [], downtimeMs: 0 },
    spentUnits: 0n,
    refundedUnits: 0n,
    rewards: { receivedUnits: 0n, liquidAtReceiptUnits: 0n, lockedRemainingUnits: 0n, distributableUnits: 0n, creditedUnits: 0n, claimedUnits: 0n, lotIds: [] },
  };
  tx.emit('campaign.created', { campaign });
  return tx.state.campaigns[id];
}

// ---------------- Contributions ----------------

export function submitContribution(tx: Tx, userId: string, campaignId: unknown, amountInput: unknown) {
  const c = requireCampaign(tx.state, campaignId);
  if (!tx.state.users[userId]) throw new DomainError('NOT_FOUND', `Participant ${userId} was not found.`);
  const amount = parsePositiveAmount(amountInput, 'USDC', 'contribution');
  if (c.status !== 'funding') {
    const why =
      c.status === 'funded' || c.status === 'running' || c.status === 'ended'
        ? 'Funding is closed: this campaign is fully funded and its allocations are frozen.'
        : 'Funding is closed: this campaign was cancelled.';
    throw new DomainError('CAMPAIGN_NOT_OPEN', why);
  }
  if (isBefore(tx.now, c.terms.fundingOpensAt)) throw new DomainError('CAMPAIGN_NOT_OPEN', 'Funding has not opened yet.');
  if (!isBefore(tx.now, c.terms.fundingDeadline)) {
    throw new DomainError('FUNDING_DEADLINE_PASSED', 'The funding deadline has passed. No new contributions are accepted.');
  }
  const remaining = c.terms.targetUnits - c.fundedUnits;
  if (amount > remaining) {
    throw new DomainError(
      'EXCEEDS_REMAINING',
      `Only ${formatAmount(remaining, 'USDC')} is left to fund. Contribute ${formatAmount(remaining, 'USDC')} or less.`,
      { remainingUnits: remaining },
    );
  }
  const min = c.terms.minContributionUnits;
  if (amount < min && amount !== remaining) {
    const msg =
      remaining < min
        ? `Only ${formatAmount(remaining, 'USDC')} is left, which is below the minimum. Contribute exactly ${formatAmount(remaining, 'USDC')} to complete funding.`
        : `The minimum contribution is ${formatAmount(min, 'USDC')}.`;
    throw new DomainError('BELOW_MINIMUM', msg, { minimumUnits: min });
  }
  const wallet = acct.wallet(userId);
  const balance = balanceOf(tx.state, wallet, 'USDC');
  if (balance < amount) {
    throw new DomainError(
      'INSUFFICIENT_BALANCE',
      `Your simulated wallet holds ${formatAmount(balance, 'USDC')}, which is less than ${formatAmount(amount, 'USDC')}.`,
      { balanceUnits: balance },
    );
  }
  const id = tx.nextId('CT', tx.state.contributions, 4);
  tx.emit(
    'contribution.accepted',
    { contribution: { id, campaignId: c.id, userId, amountUnits: amount, at: tx.now, status: 'accepted' } },
    [{ asset: 'USDC', from: wallet, to: acct.budget(c.id), amount, memo: `Contribution ${id} to ${c.id}` }],
  );
  let fundingClosed = false;
  if (c.fundedUnits === c.terms.targetUnits) {
    closeFunding(tx, c.id);
    fundingClosed = true;
  }
  const ent = c.entitlementIds.map((e) => tx.state.entitlements[e]).find((e) => e.holderId === userId);
  return {
    contributionId: id,
    campaignId: c.id,
    amountUnits: amount,
    fundedUnits: c.fundedUnits,
    remainingUnits: c.terms.targetUnits - c.fundedUnits,
    fundingClosed,
    entitlementId: ent?.id,
    allocationPercent: ent ? percentString(ent.shareNumerator, ent.shareDenominator, 4) : undefined,
  };
}

/** Freeze allocations. Called exactly once, when the target is reached. */
function closeFunding(tx: Tx, campaignId: string) {
  const c = requireCampaign(tx.state, campaignId);
  if (c.status !== 'funding' || c.fundedUnits !== c.terms.targetUnits) throw new DomainError('INVALID_STATE', 'Funding cannot close yet.');
  const byUser = new Map<string, bigint>();
  for (const cid of c.contributionIds) {
    const ct = tx.state.contributions[cid];
    byUser.set(ct.userId, (byUser.get(ct.userId) ?? 0n) + ct.amountUnits);
  }
  const entitlements: Entitlement[] = [...byUser.entries()].map(([userId, units], i) => ({
    id: `${c.id}-E${String(i + 1).padStart(2, '0')}`,
    campaignId: c.id,
    originalHolderId: userId,
    holderId: userId,
    contributedUnits: units,
    shareNumerator: units,
    shareDenominator: c.fundedUnits,
    frozenAt: tx.now,
    status: 'active',
    creditedUnits: 0n,
    claimedUnits: 0n,
    refundedUsdcUnits: 0n,
    ownership: [{ holderId: userId, from: tx.now, reason: 'funding_closed' }],
  }));
  tx.emit('campaign.funding_closed', { campaignId: c.id, fundedUnits: c.fundedUnits, rule: ALLOCATION_RULE_TEXT, entitlements });
}

// ---------------- Start / end / cancel ----------------

export function startCampaign(tx: Tx, campaignId: unknown) {
  const c = requireCampaign(tx.state, campaignId);
  if (c.status !== 'funded') {
    throw new DomainError(
      'INVALID_STATE',
      c.status === 'funding'
        ? `Only a fully funded campaign can start. ${formatAmount(c.terms.targetUnits - c.fundedUnits, 'USDC')} is still unfunded.`
        : `Campaign is ${c.status}; it cannot be started.`,
    );
  }
  const m = tx.state.miners[c.minerId];
  if (m.status === 'blacklisted') throw new DomainError('INVALID_STATE', `Miner account ${m.id} is blacklisted.`);
  if (m.currentCampaignId && m.currentCampaignId !== c.id) {
    throw new DomainError('MINER_BUSY', `Miner account ${m.id} is operating ${m.currentCampaignId}. End it before starting ${c.id}.`);
  }
  const stake = balanceOf(tx.state, acct.stake(m.id), 'FLOP');
  if (stake < m.stake.requiredBaseUnits) {
    throw new DomainError('STAKE_NOT_CONFIRMED', `Miner stake is below the ${formatAmount(m.stake.requiredBaseUnits, 'FLOP')} base requirement.`);
  }
  tx.emit('campaign.started', { campaignId: c.id, minerId: m.id, termEndsAt: addDays(tx.now, c.terms.termDays) });
  tx.as(SERVICE_ACTORS.orchestrator, () => provision(tx, c.id, 'initial'));
  return { campaignId: c.id, opsStatus: c.ops.status, activeDeploymentId: c.ops.activeDeploymentId, openIncidentIds: [...c.ops.openIncidentIds] };
}

export function endCampaign(tx: Tx, campaignId: string, reason: string) {
  const c = requireCampaign(tx.state, campaignId);
  if (c.status !== 'running') throw new DomainError('INVALID_STATE', `Only a running campaign can be ended (status: ${c.status}).`);
  tx.as(SERVICE_ACTORS.orchestrator, () => {
    for (const depId of c.ops.deploymentIds) {
      if (tx.state.deployments[depId].status !== 'running') continue;
      accrueDeployment(tx, depId);
      const dep = tx.state.deployments[depId];
      if (dep.status === 'running') {
        if (dep.instanceRef) tx.provider.terminate(dep.instanceRef);
        tx.emit('deployment.terminated', { deploymentId: depId, reason: `Campaign ended: ${reason}` });
      }
    }
  });
  tx.emit('campaign.ended', { campaignId: c.id, reason });
  tx.as(SERVICE_ACTORS.settlement, () => settleUnused(tx, c.id, reason));
  return { campaignId: c.id, spentUnits: c.spentUnits, refundedUnits: c.refundedUnits };
}

/** Return unspent budget pro rata to contributors (largest remainder; exact). */
function settleUnused(tx: Tx, campaignId: string, reason: string) {
  const c = requireCampaign(tx.state, campaignId);
  const budgetAccount = acct.budget(c.id);
  const fee = computeSettlementFee(c.terms.feeModel);
  const available = balanceOf(tx.state, budgetAccount, 'USDC');
  const unused = available - fee.usdcUnits;
  const ents = c.entitlementIds.map((id) => tx.state.entitlements[id]).filter((e) => e.status === 'active');
  const parts = apportion(unused, ents.map((e) => ({ key: e.id, weight: e.contributedUnits, tiebreak: e.id })));
  const refundIds: string[] = [];
  for (const e of ents) {
    const units = parts.get(e.id) ?? 0n;
    if (units === 0n) continue;
    const id = tx.nextId('RF', tx.state.refunds, 4);
    const refund: Refund = { id, campaignId: c.id, userId: e.originalHolderId, entitlementId: e.id, units, reason: 'unused_budget', at: tx.now };
    tx.emit('refund.issued', { refund }, [
      { asset: 'USDC', from: budgetAccount, to: acct.wallet(e.originalHolderId), amount: units, memo: `Unused budget refund ${id}` },
    ]);
    refundIds.push(id);
  }
  if (balanceOf(tx.state, budgetAccount, 'USDC') !== 0n) throw new DomainError('LEDGER_INVARIANT', 'Budget not fully settled.');
  tx.emit('campaign.settled', {
    campaignId: c.id,
    settlement: { at: tx.now, reason, budgetUnits: c.fundedUnits, spentUnits: c.spentUnits, unusedUnits: unused, refundIds, fee },
  });
}

function refundInFull(tx: Tx, c: Campaign, reason: Refund['reason']) {
  const byUser = new Map<string, { units: bigint; ids: string[] }>();
  for (const cid of c.contributionIds) {
    const ct = tx.state.contributions[cid];
    const v = byUser.get(ct.userId) ?? { units: 0n, ids: [] };
    v.units += ct.amountUnits;
    v.ids.push(ct.id);
    byUser.set(ct.userId, v);
  }
  const refundIds: string[] = [];
  for (const [userId, v] of byUser) {
    const id = tx.nextId('RF', tx.state.refunds, 4);
    const entitlementId = c.entitlementIds.find((e) => tx.state.entitlements[e].originalHolderId === userId);
    tx.emit('refund.issued', { refund: { id, campaignId: c.id, userId, entitlementId, units: v.units, reason, at: tx.now }, contributionIds: v.ids }, [
      { asset: 'USDC', from: acct.budget(c.id), to: acct.wallet(userId), amount: v.units, memo: `Full refund ${id}` },
    ]);
    refundIds.push(id);
  }
  if (balanceOf(tx.state, acct.budget(c.id), 'USDC') !== 0n) throw new DomainError('LEDGER_INVARIANT', 'Budget not fully refunded.');
  tx.emit('campaign.settled', {
    campaignId: c.id,
    settlement: { at: tx.now, reason, budgetUnits: c.fundedUnits, spentUnits: 0n, unusedUnits: c.fundedUnits, refundIds, fee: computeSettlementFee(c.terms.feeModel) },
  });
}

export function cancelCampaign(tx: Tx, campaignId: unknown, reasonInput: unknown) {
  const c = requireCampaign(tx.state, campaignId);
  if (c.status === 'running') {
    throw new DomainError('INVALID_STATE', 'This campaign is running. Use “End campaign”: money already spent on compute cannot be refunded.');
  }
  if (c.status !== 'funding' && c.status !== 'funded') throw new DomainError('INVALID_STATE', `Campaign is already ${c.status}.`);
  const reason = typeof reasonInput === 'string' && reasonInput.trim() ? reasonInput.trim().slice(0, 200) : 'Cancelled by operator before start';
  tx.emit('campaign.cancelled', { campaignId: c.id, reason });
  tx.as(SERVICE_ACTORS.settlement, () => refundInFull(tx, c, 'campaign_cancelled'));
  return { campaignId: c.id, refundedUnits: c.refundedUnits };
}

/** Deadlines and term completion that are due at the current clock. */
export function processDue(tx: Tx) {
  for (const c of Object.values(tx.state.campaigns).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (c.status === 'funding' && !isBefore(tx.now, c.terms.fundingDeadline)) {
      tx.as(SERVICE_ACTORS.system, () => tx.emit('campaign.funding_failed', { campaignId: c.id }));
      tx.as(SERVICE_ACTORS.settlement, () => refundInFull(tx, c, 'funding_failed'));
    }
    if (c.status === 'running' && c.termEndsAt && !isBefore(tx.now, c.termEndsAt)) {
      tx.as(SERVICE_ACTORS.system, () => endCampaign(tx, c.id, 'Operating term completed'));
    }
  }
}

// ---------------- Command definitions ----------------

export const campaignCommands: CommandDef[] = [
  {
    type: 'campaign.create',
    actors: ['operator', 'seed'],
    handler: (tx, input: CreateCampaignInput) => {
      const c = createCampaign(tx, input);
      return { campaignId: c.id };
    },
  },
  {
    type: 'contribution.submit',
    actors: ['participant'],
    handler: (tx, input: { campaignId: string; amount: string }) => submitContribution(tx, tx.actor.id, input.campaignId, input.amount),
  },
  {
    type: 'campaign.start',
    actors: ['operator'],
    handler: (tx, input: { campaignId: string }) => startCampaign(tx, input.campaignId),
  },
  {
    type: 'campaign.end',
    actors: ['operator'],
    handler: (tx, input: { campaignId: string; reason?: string }) => {
      const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 200) : 'Ended early by operator';
      requireCampaign(tx.state, input.campaignId);
      return endCampaign(tx, input.campaignId, reason);
    },
  },
  {
    type: 'campaign.cancel',
    actors: ['operator'],
    handler: (tx, input: { campaignId: string; reason?: string }) => cancelCampaign(tx, input.campaignId, input.reason),
  },
];
