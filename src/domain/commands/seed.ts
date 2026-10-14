// Seeded demo data: one miner account, two campaigns on it, and $2,400 of the
// first campaign's $3,000 already funded by simulated participants.

import { acct } from '../accounts';
import { DEMO, PROTOCOL_ASSUMPTIONS } from '../config';
import type { CommandDef, Tx } from '../engine';
import { formatAmount, usdc } from '../money';
import { initialSimOffers } from '../providers/simulated';
import { addDays } from '../time';
import type { User } from '../types';
import { createCampaign, submitContribution } from './campaigns';
import { topUp } from './demo';

const SEEDED: { id: string; name: string; c1: string }[] = [
  { id: 'u-avery', name: 'Avery', c1: '1000' },
  { id: 'u-bo', name: 'Bo', c1: '700' },
  { id: 'u-chidi', name: 'Chidi', c1: '400' },
  { id: 'u-dana', name: 'Dana', c1: '300' },
];

function bootstrap(tx: Tx) {
  const users: User[] = [
    { id: DEMO.demoUserId, displayName: 'You (demo participant)', kind: 'demo_participant', createdAt: tx.now },
    ...SEEDED.map((s) => ({ id: s.id, displayName: `${s.name} (simulated)`, kind: 'simulated_participant' as const, createdAt: tx.now })),
  ];
  for (const user of users) tx.emit('user.registered', { user });
  topUp(tx, DEMO.demoUserId, DEMO.demoUserStartingUsdc);
  for (const s of SEEDED) topUp(tx, s.id, usdc(s.c1));

  tx.emit('miner.registered', {
    miner: {
      id: DEMO.minerId,
      label: 'Miner account M-01 (simulated)',
      tier: 'SOFT',
      status: 'active',
      stake: {
        requiredBaseUnits: PROTOCOL_ASSUMPTIONS.baseMinerSelfStakeFlop,
        supplier: 'Unresolved',
        supplierNote: 'Who supplies the miner stake is undecided. It is not paid from any campaign budget. The demo records a placeholder stake.',
        bondNote: PROTOCOL_ASSUMPTIONS.capacityExposureBond,
        slashedUnits: 0n,
      },
      windows: [],
      createdAt: tx.now,
    },
  });
  tx.emit('miner.stake_recorded', { minerId: DEMO.minerId, units: PROTOCOL_ASSUMPTIONS.baseMinerSelfStakeFlop, supplier: 'Unresolved (demo placeholder)', simulated: true }, [
    { asset: 'FLOP', from: acct.stakeSupplier, to: acct.stake(DEMO.minerId), amount: PROTOCOL_ASSUMPTIONS.baseMinerSelfStakeFlop, memo: 'Placeholder base self-stake (supplier unresolved)' },
  ]);
  tx.emit('sim.offers_seeded', { offers: initialSimOffers() });

  const c1 = createCampaign(tx, {
    name: 'Campaign 1 · 80 GB GPU miner',
    summary: 'One month of a managed FLOP miner on a rented 80 GB-class GPU. Contributors share the rewards this campaign earns.',
    minerId: DEMO.minerId,
    target: '3000',
    minContribution: '100',
    fundingDeadline: addDays(tx.now, 14),
    termDays: 30,
  });
  for (const s of SEEDED) {
    tx.as({ kind: 'participant', id: s.id }, () => submitContribution(tx, s.id, c1.id, s.c1));
  }
  const c2 = createCampaign(tx, {
    name: 'Campaign 2 · same miner account, next month',
    summary: 'A later 30-day campaign on the same miner account. It earns only from its own operating period and does not share in Campaign 1 rewards.',
    minerId: DEMO.minerId,
    target: '3000',
    minContribution: '100',
    fundingDeadline: addDays(tx.now, 75),
    termDays: 30,
  });
  return {
    campaigns: [c1.id, c2.id],
    remainingC1: formatAmount(c1.terms.targetUnits - c1.fundedUnits, 'USDC'),
  };
}

export const seedCommand: CommandDef = { type: 'seed.bootstrap', actors: ['seed'], handler: (tx) => bootstrap(tx) };
export const SEED_REQUEST = { type: 'seed.bootstrap', input: {}, idempotencyKey: 'seed-bootstrap-v1' };
export const SEED_ACTOR = { kind: 'seed' as const, id: 'seed' };
