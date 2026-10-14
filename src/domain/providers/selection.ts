// Offer eligibility and ranking. Pure functions.
//
// The orchestrator never picks the lowest advertised hourly rate blindly. An offer
// must pass hard requirements (capacity, availability, non-interruptible,
// reliability floor, verified host, fits the remaining budget for the remaining
// term). Eligible offers are ranked by reliability-adjusted total cost.

import { formatAmount } from '../money';
import { HOUR_MS, diffMs } from '../time';
import type { ExcludedOffer, HardwareRequirements, OfferCheck, ProviderOffer } from '../types';

export interface SelectionInput {
  offers: ProviderOffer[];
  requirements: HardwareRequirements;
  budgetUnits: bigint;
  now: string;
  termEndsAt: string;
  excluded: ExcludedOffer[];
}

export function remainingHours(now: string, termEndsAt: string): number {
  return Math.max(0, Math.ceil(diffMs(termEndsAt, now) / HOUR_MS));
}

export function evaluateOffers(input: SelectionInput): { checks: OfferCheck[]; selected?: OfferCheck; hours: number } {
  const hours = remainingHours(input.now, input.termEndsAt);
  const req = input.requirements;
  const checks: OfferCheck[] = input.offers.map((o) => {
    const reasons: string[] = [];
    const estimatedTotalUnits = o.setupFeeUnits + o.hourlyUnits * BigInt(hours);
    if (!o.available) reasons.push('Not available');
    if (o.vramGb < req.minVramGb) reasons.push(`${o.vramGb} GB VRAM is below the ${req.minVramGb} GB requirement`);
    if (o.interruptible && !req.allowInterruptible) reasons.push('Interruptible (spot) instance');
    if (o.reliabilityBps < req.minReliabilityBps) {
      reasons.push(`Reliability ${(o.reliabilityBps / 100).toFixed(1)}% is below ${(req.minReliabilityBps / 100).toFixed(1)}%`);
    }
    if (req.requireVerifiedHost && !o.verifiedHost) reasons.push('Host not verified');
    const ex = input.excluded.find((x) => x.offerId === o.id);
    if (ex) reasons.push(ex.reason === 'host_failed' ? 'Host failed earlier in this campaign' : 'Deployment failed earlier in this run');
    if (estimatedTotalUnits > input.budgetUnits) {
      reasons.push(
        `Estimated ${formatAmount(estimatedTotalUnits, 'USDC')} for ${hours} h exceeds remaining budget ${formatAmount(input.budgetUnits, 'USDC')}`,
      );
    }
    const scoreUnits = o.reliabilityBps > 0 ? (estimatedTotalUnits * 10_000n) / BigInt(o.reliabilityBps) : estimatedTotalUnits * 1000n;
    return { offerId: o.id, eligible: reasons.length === 0, reasons, estimatedTotalUnits, scoreUnits };
  });
  const ranked = checks
    .filter((c) => c.eligible)
    .sort((a, b) => (a.scoreUnits === b.scoreUnits ? (a.offerId < b.offerId ? -1 : 1) : a.scoreUnits < b.scoreUnits ? -1 : 1));
  ranked.forEach((c, i) => (c.rank = i + 1));
  return { checks, selected: ranked[0], hours };
}
