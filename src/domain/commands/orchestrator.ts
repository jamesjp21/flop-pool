// Orchestration state machine for a campaign's miner.
//
//   not_started --start--> provisioning --deploy ok--> healthy
//   provisioning/recovering --deploy failed--> try next eligible offer (up to N per run)
//   healthy --health check failed--> recovering --> (replacement) healthy
//   recovering --no eligible offers / attempts exhausted--> manual_intervention (+ incident)
//   manual_intervention --operator retry--> recovering --> ...
//   any --campaign ends--> stopped
//
// The orchestrator acts as the `orchestrator` service actor. Its only ledger right
// is paying a provider from the campaign budget (accounts.ts POSTING_POLICY).

import { acct } from '../accounts';
import { ORCHESTRATION } from '../config';
import { SERVICE_ACTORS, type CommandDef, type Tx } from '../engine';
import { DomainError } from '../errors';
import { formatAmount } from '../money';
import { evaluateOffers } from '../providers/selection';
import { WORKLOAD_SPEC_NOTE } from '../providers/types';
import { balanceOf } from '../state';
import { HOUR_MS, diffMs, isBefore, minIso } from '../time';
import type { Deployment, Incident, OfferEvaluation } from '../types';
import { requireCampaign } from './campaigns';

type Purpose = OfferEvaluation['purpose'];

export function provision(tx: Tx, campaignId: string, purpose: Purpose, opts: { forcedOfferId?: string } = {}) {
  const c = requireCampaign(tx.state, campaignId);
  const attempts: Incident['attempts'] = [];
  for (let attempt = 1; ; attempt++) {
    if (c.status !== 'running' || !c.termEndsAt) return;
    const budget = balanceOf(tx.state, acct.budget(c.id), 'USDC');
    const offers = tx.provider.listOffers();
    const forced = attempt === 1 ? opts.forcedOfferId : undefined;
    const { checks, selected, hours } = evaluateOffers({
      offers,
      requirements: c.terms.hardware,
      budgetUnits: budget,
      now: tx.now,
      termEndsAt: c.termEndsAt,
      // An operator-chosen offer overrides earlier exclusions, but not the hard requirements.
      excluded: forced ? c.ops.excludedOffers.filter((x) => x.offerId !== forced) : c.ops.excludedOffers,
    });
    let chosenId = selected?.offerId;
    if (forced) {
      const check = checks.find((x) => x.offerId === forced);
      if (!check) throw new DomainError('NOT_FOUND', `Offer ${forced} is not in the simulated market.`);
      if (!check.eligible) throw new DomainError('INVALID_INPUT', `Offer ${forced} is not eligible: ${check.reasons.join('; ')}.`);
      chosenId = forced;
    }
    const evaluation: OfferEvaluation = {
      id: tx.nextId('EV', tx.state.evaluations),
      campaignId: c.id,
      at: tx.now,
      purpose,
      remainingHours: hours,
      budgetUnits: budget,
      checks,
      selectedOfferId: chosenId,
      marketMode: tx.state.sim.marketMode,
    };
    tx.emit('orchestrator.offers_evaluated', { evaluation, forcedByOperator: Boolean(forced) });

    if (!chosenId) {
      escalate(tx, c.id, attempts, attempts.length ? 'Replacement attempts failed and no eligible offers remain.' : 'No eligible offers are available.');
      return;
    }
    const offer = offers.find((o) => o.id === chosenId)!;
    const deploymentId = tx.nextId('D', tx.state.deployments);
    const { simDeployOutcome: _o, simFailureDetail: _d, available: _a, ...offerSnapshot } = offer;
    const deployment: Deployment = {
      id: deploymentId,
      campaignId: c.id,
      minerId: c.minerId,
      offer: offerSnapshot,
      attempt,
      purpose,
      status: 'requested',
      requestedAt: tx.now,
      rentalCostUnits: 0n,
      setupFeeUnits: 0n,
    };
    tx.emit('deployment.requested', { deployment, workload: { minerAccountId: c.minerId, tier: 'SOFT', image: 'placeholder', note: WORKLOAD_SPEC_NOTE } });

    // Setup fee is charged per attempt, success or not.
    if (!charge(tx, deploymentId, 'setup_fee', offer.setupFeeUnits)) {
      tx.emit('deployment.start_failed', { deploymentId, kind: 'budget_exhausted', detail: 'Budget cannot cover the setup fee.' });
      openIncident(tx, c.id, 'budget_exhausted', 'Campaign budget exhausted', 'The remaining budget cannot cover another deployment.', attempts);
      return;
    }
    const outcome = tx.provider.deploy(offer, { minerAccountId: c.minerId, tier: 'SOFT', image: 'placeholder' }, deploymentId);
    if (outcome.ok) {
      tx.emit('deployment.running', { deploymentId, instanceRef: outcome.instanceRef, simulated: true });
      return;
    }
    tx.emit('deployment.start_failed', { deploymentId, kind: outcome.kind, detail: outcome.detail });
    attempts.push({ deploymentId, offerId: offer.id, outcome: outcome.detail });
    if (attempt >= ORCHESTRATION.maxAutoAttemptsPerRun) {
      escalate(tx, c.id, attempts, `Automated recovery stopped after ${attempt} failed deployment attempts.`);
      return;
    }
  }
}

function escalate(tx: Tx, campaignId: string, attempts: Incident['attempts'], summary: string) {
  openIncident(
    tx,
    campaignId,
    'recovery_exhausted',
    'Miner is down: automated recovery could not find a working machine',
    `${summary} The campaign term keeps running while the miner is down. An operator must choose a machine or end the campaign.`,
    attempts,
  );
}

export function openIncident(
  tx: Tx,
  campaignId: string,
  kind: Incident['kind'],
  title: string,
  detail: string,
  attempts: Incident['attempts'],
) {
  const c = requireCampaign(tx.state, campaignId);
  const incident: Incident = {
    id: tx.nextId('INC', tx.state.incidents),
    campaignId,
    kind,
    severity: 'critical',
    status: 'open',
    openedAt: tx.now,
    title,
    detail,
    attempts,
    escalation: { recipient: ORCHESTRATION.escalationRecipient, channel: ORCHESTRATION.escalationChannel },
  };
  tx.emit('incident.opened', { incident });
  if (c.status === 'running' && c.ops.status !== 'manual_intervention') {
    tx.emit('ops.status_changed', { campaignId, status: 'manual_intervention', reason: title });
  }
  return incident;
}

/** Charge the campaign budget; refuses (returns false) rather than overdrawing. */
function charge(tx: Tx, deploymentId: string, kind: 'setup_fee' | 'gpu_rental', units: bigint, period?: { from: string; to: string; rentalCostUnits: bigint }): boolean {
  if (units <= 0n) return true;
  const dep = tx.state.deployments[deploymentId];
  const budget = balanceOf(tx.state, acct.budget(dep.campaignId), 'USDC');
  if (budget < units) return false;
  const id = tx.nextId('X', tx.state.expenditures, 4);
  tx.emit(
    'expenditure.recorded',
    {
      expenditure: { id, campaignId: dep.campaignId, deploymentId, providerId: dep.offer.providerId, kind, units, at: tx.now, periodFrom: period?.from, periodTo: period?.to },
      deployment: {
        billedTo: period?.to ?? dep.billedTo,
        rentalCostUnits: period?.rentalCostUnits ?? dep.rentalCostUnits,
        setupFeeUnits: kind === 'setup_fee' ? dep.setupFeeUnits + units : dep.setupFeeUnits,
      },
    },
    [{ asset: 'USDC', from: acct.budget(dep.campaignId), to: acct.provider(dep.offer.providerId), amount: units, memo: `${kind === 'setup_fee' ? 'Setup fee' : 'GPU rental'} for ${deploymentId}` }],
  );
  return true;
}

/**
 * Meter a running deployment up to now (capped at term end). Rental is computed
 * cumulatively from the start time, floor(rate × elapsed), so the result is the
 * same however often the clock is advanced.
 */
export function accrueDeployment(tx: Tx, deploymentId: string) {
  const dep = tx.state.deployments[deploymentId];
  if (!dep || dep.status !== 'running' || !dep.runningAt) return;
  const c = requireCampaign(tx.state, dep.campaignId);
  const until = c.termEndsAt ? minIso(tx.now, c.termEndsAt) : tx.now;
  if (!isBefore(dep.billedTo ?? dep.runningAt, until)) return;
  const target = (dep.offer.hourlyUnits * BigInt(diffMs(until, dep.runningAt))) / BigInt(HOUR_MS);
  const delta = target - dep.rentalCostUnits;
  if (delta <= 0n) return;
  const budget = balanceOf(tx.state, acct.budget(c.id), 'USDC');
  if (delta <= budget) {
    charge(tx, dep.id, 'gpu_rental', delta, { from: dep.billedTo ?? dep.runningAt, to: until, rentalCostUnits: target });
    return;
  }
  // Never overdraw: bill what is left, stop the machine, and escalate.
  if (budget > 0n) charge(tx, dep.id, 'gpu_rental', budget, { from: dep.billedTo ?? dep.runningAt, to: until, rentalCostUnits: dep.rentalCostUnits + budget });
  if (dep.instanceRef) tx.provider.terminate(dep.instanceRef);
  tx.emit('deployment.terminated', { deploymentId: dep.id, reason: 'Budget exhausted' });
  openIncident(tx, c.id, 'budget_exhausted', 'Campaign budget exhausted', `The budget ran out at ${formatAmount(c.spentUnits, 'USDC')} spent. The machine was stopped.`, []);
}

export function accrueAll(tx: Tx) {
  tx.as(SERVICE_ACTORS.orchestrator, () => {
    for (const c of Object.values(tx.state.campaigns)) {
      if (c.status === 'running' && c.ops.activeDeploymentId) accrueDeployment(tx, c.ops.activeDeploymentId);
    }
  });
}

/** A failure observed by the (simulated) health monitor. */
export function handleHealthFailure(tx: Tx, campaignId: string, kind: string, detail: string) {
  const c = requireCampaign(tx.state, campaignId);
  const depId = c.ops.activeDeploymentId;
  if (c.status !== 'running' || !depId || c.ops.status !== 'healthy') {
    throw new DomainError('INVALID_STATE', 'There is no healthy machine to fail for this campaign.');
  }
  tx.as(SERVICE_ACTORS.orchestrator, () => {
    accrueDeployment(tx, depId);
    const dep = tx.state.deployments[depId];
    if (dep.status !== 'running') return;
    tx.emit('deployment.health_failed', { deploymentId: depId, kind, detail, detectedBy: 'Health monitor (simulated)', treatedAs: 'downtime, not fraud' });
    if (dep.instanceRef) tx.provider.terminate(dep.instanceRef);
    provision(tx, c.id, 'replacement');
  });
}

export const orchestratorCommands: CommandDef[] = [
  {
    type: 'ops.retryRecovery',
    actors: ['operator'],
    handler: (tx, input: { campaignId: string; offerId?: string }) => {
      const c = requireCampaign(tx.state, input.campaignId);
      if (c.status !== 'running' || c.ops.status !== 'manual_intervention') {
        throw new DomainError('INVALID_STATE', 'Recovery can only be retried while the campaign needs manual intervention.');
      }
      tx.emit('ops.exclusions_cleared', { campaignId: c.id, reason: 'deploy_failed' });
      tx.emit('ops.status_changed', { campaignId: c.id, status: 'recovering', reason: 'Operator retried recovery' });
      const forcedOfferId = typeof input.offerId === 'string' && input.offerId ? input.offerId : undefined;
      tx.as(SERVICE_ACTORS.orchestrator, () => provision(tx, c.id, 'manual_retry', { forcedOfferId }));
      return { campaignId: c.id, opsStatus: c.ops.status, activeDeploymentId: c.ops.activeDeploymentId };
    },
  },
  {
    type: 'incident.acknowledge',
    actors: ['operator'],
    handler: (tx, input: { incidentId: string }) => {
      const i = tx.state.incidents[input.incidentId];
      if (!i) throw new DomainError('NOT_FOUND', 'Incident not found.');
      if (i.status !== 'open') throw new DomainError('INVALID_STATE', `Incident is already ${i.status}.`);
      tx.emit('incident.acknowledged', { incidentId: i.id });
      return { incidentId: i.id, status: 'acknowledged' };
    },
  },
  {
    type: 'incident.resolve',
    actors: ['operator'],
    handler: (tx, input: { incidentId: string; note?: string }) => {
      const i = tx.state.incidents[input.incidentId];
      if (!i) throw new DomainError('NOT_FOUND', 'Incident not found.');
      if (i.status === 'resolved') throw new DomainError('INVALID_STATE', 'Incident is already resolved.');
      const c = requireCampaign(tx.state, i.campaignId);
      if (c.status === 'running' && c.ops.status !== 'healthy' && i.kind !== 'miner_blacklisted') {
        throw new DomainError('INVALID_STATE', 'The miner is still down. Restore a healthy machine or end the campaign before resolving.');
      }
      const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 300) : 'Resolved by operator';
      tx.emit('incident.resolved', { incidentId: i.id, note });
      return { incidentId: i.id, status: 'resolved' };
    },
  },
];
