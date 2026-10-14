// Demo-only controls. Every one of these is a simulation, refused when demo mode
// is off, and recorded in the audit log under the `demo` actor.

import { acct } from '../accounts';
import { SERVICE_ACTORS, type CommandDef, type Tx } from '../engine';
import { DomainError } from '../errors';
import { formatAmount, maxBig, minBig, parsePositiveAmount, usdc } from '../money';
import { reserveSimOffers } from '../providers/simulated';
import { balanceOf } from '../state';
import { addHours, isBefore, toMs } from '../time';
import type { MarketMode } from '../types';
import { processDue, requireCampaign, submitContribution } from './campaigns';
import { accrueAll, handleHealthFailure, openIncident } from './orchestrator';

export function advanceClock(tx: Tx, hours: number) {
  const target = addHours(tx.now, hours);
  for (let guard = 0; isBefore(tx.now, target); guard++) {
    if (guard > 200) throw new Error('advanceClock: too many milestones');
    const milestones: string[] = [];
    for (const c of Object.values(tx.state.campaigns)) {
      if (c.status === 'funding') milestones.push(c.terms.fundingDeadline);
      if (c.status === 'running' && c.termEndsAt) milestones.push(c.termEndsAt);
    }
    const next = milestones.filter((t) => isBefore(tx.now, t) && !isBefore(target, t)).sort((a, b) => toMs(a) - toMs(b))[0] ?? target;
    tx.emit('clock.advanced', { from: tx.now, to: next, simulated: true });
    accrueAll(tx);
    processDue(tx);
  }
  return { clock: tx.now };
}

export function topUp(tx: Tx, userId: string, amount: bigint) {
  tx.emit('wallet.topped_up', { userId, units: amount, simulated: true }, [
    { asset: 'USDC', from: acct.faucet, to: acct.wallet(userId), amount, memo: 'Simulated USDC (demo faucet)' },
  ]);
}

const FAILURES: Record<string, string> = {
  host_unreachable: 'Host stopped responding to health checks.',
  gpu_error: 'GPU reported an uncorrectable error.',
  miner_exited: 'Miner workload exited repeatedly and could not be restarted in place.',
};

const FILL_PATTERN = ['900', '750', '600', '450', '300'];

export const demoCommands: CommandDef[] = [
  {
    type: 'demo.advanceClock',
    actors: ['demo'],
    demo: true,
    handler: (tx, input: { hours: number }) => {
      const hours = Number(input.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 120) throw new DomainError('INVALID_INPUT', 'Advance by 1 to 2880 whole hours.');
      return advanceClock(tx, hours);
    },
  },
  {
    type: 'demo.injectFailure',
    actors: ['demo'],
    demo: true,
    handler: (tx, input: { campaignId: string; kind?: string }) => {
      const kind = input.kind && FAILURES[input.kind] ? input.kind : 'host_unreachable';
      const c = requireCampaign(tx.state, input.campaignId);
      tx.emit('sim.failure_injected', { campaignId: c.id, deploymentId: c.ops.activeDeploymentId, kind });
      handleHealthFailure(tx, c.id, kind, `${FAILURES[kind]} (simulated)`);
      return { campaignId: c.id, opsStatus: c.ops.status, activeDeploymentId: c.ops.activeDeploymentId, openIncidentIds: [...c.ops.openIncidentIds] };
    },
  },
  {
    type: 'demo.setMarketMode',
    actors: ['demo'],
    demo: true,
    handler: (tx, input: { mode: MarketMode }) => {
      const modes: MarketMode[] = ['normal', 'deploy_outage', 'no_capacity'];
      if (!modes.includes(input.mode)) throw new DomainError('INVALID_INPUT', `Market mode must be one of ${modes.join(', ')}.`);
      tx.emit('sim.market_mode_set', { mode: input.mode });
      return { mode: input.mode };
    },
  },
  {
    type: 'demo.addCapacity',
    actors: ['demo'],
    demo: true,
    handler: (tx) => {
      const next = reserveSimOffers().find((o) => !tx.state.sim.offers[o.id]);
      if (!next) throw new DomainError('INVALID_STATE', 'All reserve simulated offers are already online.');
      tx.emit('sim.offers_seeded', { offers: [next] });
      return { offerId: next.id };
    },
  },
  {
    type: 'demo.simulateSlash',
    actors: ['demo'],
    demo: true,
    handler: (tx, input: { minerId: string; amount: string; blacklist?: boolean; reason?: string }) => {
      const m = tx.state.miners[input.minerId];
      if (!m) throw new DomainError('NOT_FOUND', 'Miner account not found.');
      const units = parsePositiveAmount(input.amount, 'FLOP', 'slash amount');
      const stakeAccount = acct.stake(m.id);
      const stake = balanceOf(tx.state, stakeAccount, 'FLOP');
      if (units > stake) throw new DomainError('INVALID_INPUT', `Slash exceeds the recorded stake of ${formatAmount(stake, 'FLOP')}.`);
      const blacklisted = Boolean(input.blacklist);
      tx.emit(
        'miner.stake_slashed',
        {
          minerId: m.id,
          units,
          blacklisted,
          reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 200) : 'Simulated proven-fraud finding',
          affectedAccount: stakeAccount,
          stakeSupplier: m.stake.supplier,
          participantBalancesAffected: false,
          simulated: true,
        },
        [{ asset: 'FLOP', from: stakeAccount, to: acct.slashed, amount: units, memo: 'Simulated slash of miner stake' }],
      );
      if (blacklisted && m.currentCampaignId) {
        tx.as(SERVICE_ACTORS.orchestrator, () =>
          openIncident(tx, m.currentCampaignId!, 'miner_blacklisted', 'Miner account blacklisted', 'The protocol blacklisted this miner account. Decide whether to end the campaign.', []),
        );
      }
      return { minerId: m.id, slashedUnits: units, remainingStakeUnits: balanceOf(tx.state, stakeAccount, 'FLOP') };
    },
  },
  {
    type: 'demo.fillFunding',
    actors: ['demo'],
    demo: true,
    handler: (tx, input: { campaignId: string }) => {
      const c = requireCampaign(tx.state, input.campaignId);
      if (c.status !== 'funding') throw new DomainError('INVALID_STATE', 'Campaign is not open for funding.');
      const added: string[] = [];
      for (let i = 0; c.fundedUnits < c.terms.targetUnits; i++) {
        if (i > 500) throw new DomainError('INVALID_STATE', 'Too many simulated participants would be needed; contribute directly instead.');
        const remaining = c.terms.targetUnits - c.fundedUnits;
        const pattern = usdc(FILL_PATTERN[i % FILL_PATTERN.length]);
        const scaled = pattern * (c.terms.targetUnits / usdc('3000') > 1n ? c.terms.targetUnits / usdc('3000') : 1n);
        let amount = minBig(maxBig(scaled, c.terms.minContributionUnits), remaining);
        if (remaining - amount > 0n && remaining - amount < c.terms.minContributionUnits) amount = remaining;
        const userId = `u-sim-${String(Object.keys(tx.state.users).length + 1).padStart(2, '0')}`;
        tx.emit('user.registered', {
          user: { id: userId, displayName: `Simulated participant ${userId.slice(-2)}`, kind: 'simulated_participant', createdAt: tx.now },
        });
        topUp(tx, userId, amount);
        tx.as({ kind: 'participant', id: userId }, () => submitContribution(tx, userId, c.id, formatAmount(amount, 'USDC', { symbol: false, grouping: false, maxFraction: 6 })));
        added.push(userId);
      }
      return { campaignId: c.id, addedParticipants: added, fundedUnits: c.fundedUnits };
    },
  },
  {
    type: 'demo.topUp',
    actors: ['demo'],
    demo: true,
    handler: (tx, input: { userId: string; amount: string }) => {
      if (!tx.state.users[input.userId]) throw new DomainError('NOT_FOUND', 'Participant not found.');
      const amount = parsePositiveAmount(input.amount, 'USDC', 'top-up amount');
      if (amount > usdc('100000')) throw new DomainError('INVALID_INPUT', 'Top up at most 100,000 simulated USDC at a time.');
      topUp(tx, input.userId, amount);
      return { userId: input.userId, balanceUnits: balanceOf(tx.state, acct.wallet(input.userId), 'USDC') };
    },
  },
];
