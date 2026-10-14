// Human-readable one-line descriptions of events for the audit log.

import { formatAmount } from './money';
import type { DomainEvent } from './types';

const usd = (u: bigint) => formatAmount(u, 'USDC');
const flp = (u: bigint) => formatAmount(u, 'FLOP');

export function campaignIdOf(ev: DomainEvent): string | undefined {
  const d = ev.data ?? {};
  return (
    d.campaignId ??
    d.campaign?.id ??
    d.contribution?.campaignId ??
    d.deployment?.campaignId ??
    d.evaluation?.campaignId ??
    d.expenditure?.campaignId ??
    d.incident?.campaignId ??
    d.refund?.campaignId ??
    d.distribution?.campaignId ??
    d.claim?.campaignId ??
    (d.lots ? d.lots.find((l: any) => l.campaignId)?.campaignId : undefined) ??
    (d.unlock ? d.unlock.perLot.find((l: any) => l.campaignId)?.campaignId : undefined)
  );
}

export function describeEvent(ev: DomainEvent): string {
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'user.registered':
      return `Registered participant ${d.user.displayName}`;
    case 'wallet.topped_up':
      return `Credited ${usd(d.units)} (simulated) to ${d.userId}`;
    case 'miner.registered':
      return `Registered ${d.miner.label}, ${d.miner.tier} tier`;
    case 'miner.stake_recorded':
      return `Recorded ${flp(d.units)} miner stake on ${d.minerId}; supplier: ${d.supplier}`;
    case 'miner.stake_slashed':
      return `Slashed ${flp(d.units)} from ${d.affectedAccount}${d.blacklisted ? ' and blacklisted the miner' : ''}. Participant balances unaffected.`;
    case 'sim.offers_seeded':
      return `Simulated market: ${d.offers.length} offer${d.offers.length === 1 ? '' : 's'} online (${d.offers.map((o: any) => o.id).join(', ')})`;
    case 'sim.market_mode_set':
      return `Simulated market mode set to “${d.mode}”`;
    case 'sim.failure_injected':
      return `Demo control injected a ${d.kind} failure on ${d.deploymentId ?? 'the miner'}`;
    case 'clock.advanced':
      return `Demo clock advanced to ${d.to.slice(0, 16).replace('T', ' ')} UTC`;
    case 'campaign.created':
      return `Created ${d.campaign.id} “${d.campaign.name}”: target ${usd(d.campaign.terms.targetUnits)}, minimum ${usd(d.campaign.terms.minContributionUnits)}`;
    case 'contribution.accepted':
      return `Accepted ${usd(d.contribution.amountUnits)} from ${d.contribution.userId} (${d.contribution.id})`;
    case 'campaign.funding_closed':
      return `Funding closed at ${usd(d.fundedUnits)}; froze ${d.entitlements.length} allocations`;
    case 'campaign.funding_failed':
      return `Funding deadline passed before the target; campaign failed`;
    case 'campaign.cancelled':
      return `Cancelled: ${d.reason}`;
    case 'campaign.started':
      return `Started; term ends ${d.termEndsAt.slice(0, 10)}; operating window opened on ${d.minerId}`;
    case 'campaign.ended':
      return `Ended: ${d.reason}; operating window closed`;
    case 'campaign.settled':
      return `Settled: spent ${usd(d.settlement.spentUnits)}, returned ${usd(d.settlement.unusedUnits)} unused; fee ${usd(d.settlement.fee.usdcUnits)} (${d.settlement.fee.model})`;
    case 'ops.status_changed':
      return `Miner status → ${d.status}${d.reason ? `: ${d.reason}` : ''}`;
    case 'ops.exclusions_cleared':
      return `Operator cleared deploy-failure exclusions for a fresh attempt`;
    case 'orchestrator.offers_evaluated': {
      const e = d.evaluation;
      const eligible = e.checks.filter((c: any) => c.eligible).length;
      return `Evaluated ${e.checks.length} simulated offers (${eligible} eligible) for ${e.purpose}; ${e.selectedOfferId ? `selected ${e.selectedOfferId}${d.forcedByOperator ? ' (operator choice)' : ''}` : 'none selected'}`;
    }
    case 'deployment.requested':
      return `Requested ${d.deployment.id} on ${d.deployment.offer.id} (${d.deployment.offer.gpuModel}, ${d.deployment.offer.providerLabel}) attempt ${d.deployment.attempt}`;
    case 'deployment.running':
      return `${d.deploymentId} is running and healthy (simulated)`;
    case 'deployment.start_failed':
      return `${d.deploymentId} failed to start: ${d.detail}`;
    case 'deployment.health_failed':
      return `${d.deploymentId} failed health checks: ${d.detail} Treated as downtime, not fraud.`;
    case 'deployment.terminated':
      return `${d.deploymentId} terminated: ${d.reason}`;
    case 'expenditure.recorded':
      return `Spent ${usd(d.expenditure.units)} on ${d.expenditure.kind === 'setup_fee' ? 'setup fee' : 'GPU rental'} for ${d.expenditure.deploymentId}`;
    case 'incident.opened':
      return `Incident ${d.incident.id} opened: ${d.incident.title}. Escalation to ${d.incident.escalation.recipient}: not sent (prototype)`;
    case 'incident.acknowledged':
      return `Incident ${d.incidentId} acknowledged`;
    case 'incident.resolved':
      return `Incident ${d.incidentId} resolved: ${d.note}`;
    case 'refund.issued':
      return `Refunded ${usd(d.refund.units)} to ${d.refund.userId} (${d.refund.reason.replace(/_/g, ' ')})`;
    case 'reward.receipt_recorded': {
      const r = d.receipt;
      const lots = d.lots.map((l: any) => `${flp(l.amountUnits)} → ${l.campaignId ?? 'unattributed'}`).join(', ');
      return `Recorded ${r.kind.replace('_', ' ')} receipt ${r.id} of ${flp(r.amountUnits)} (${flp(r.lockedUnits)} locked); ref ${r.externalRef}; ${lots}`;
    }
    case 'reward.unlocked':
      return `Unlocked ${flp(d.unlock.amountUnits)} of ${d.unlock.receiptId}; ref ${d.unlock.externalRef}`;
    case 'reward.distributed':
      return `Credited ${flp(d.distribution.credits.reduce((s: bigint, c: any) => s + c.units, 0n))} to ${d.distribution.credits.length} allocation(s); residual ${formatAmount(d.distribution.residualAfter, 'FLOP', { maxFraction: 18 })}`;
    case 'claim.paid':
      return `Paid claim ${d.claim.id}: ${flp(d.claim.units)} to ${d.claim.holderId} (simulated transfer ${d.claim.simulatedTxRef})`;
    case 'command.completed':
      return `Command ${d.commandType} completed`;
    default:
      return ev.type;
  }
}
