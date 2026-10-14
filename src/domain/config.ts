// Product and protocol assumptions used by the prototype.
//
// FLOP protocol facts below come from the user's summary of the public draft
// documentation as inspected on 2026-10-14 (https://flop.finance/intro/miner/,
// https://flop.finance/intro/yellowpaper/). Those pages could not be fetched from
// the build environment, so nothing here was re-verified. None of it is a stable
// API, and the prototype does not call any FLOP endpoint.

import { flop, usdc } from './money';

export const PROTOCOL_ASSUMPTIONS = {
  source: 'Public FLOP draft docs as summarized on 2026-10-14; not re-verified from this environment.',
  baseMinerSelfStakeFlop: flop('10000'),
  capacityExposureBond: 'Calculated by the FLOP runtime; not modeled in this prototype.',
  defaultTier: 'SOFT',
  softTierNote: 'Ordinary GPUs are contemplated under the default SOFT tier; an H100 is not universally required.',
  settlementNote: 'Draft docs say SOFT settlement and disputes are still being specified; the wired settlement path is attested.',
  rewardSettlementNote: 'Block rewards and session payments settle to the miner account. Automatic distribution to contributors is not assumed.',
  slashingNote: 'Proven fraud can slash up to 100% of stake and blacklist a miner. Ordinary downtime is not treated as fraud.',
  airdropDraft: {
    liquidAtGenesisBps: 2500,
    unlockRule: 'Remaining amount unlocks 1 FLOP per FLOP earned serving paid inference on mainnet. Block rewards do not count.',
    status: 'Draft design; differs from documented runtime; genesis distribution wiring incomplete.',
  },
} as const;

export const DEMO = {
  /** Simulated starting point for the demo clock. */
  clockStart: '2026-10-14T09:00:00.000Z',
  demoUserId: 'u-demo',
  demoUserStartingUsdc: usdc('1000'),
  minerId: 'M-01',
};

export const ORCHESTRATION = {
  /** Automated deployment attempts per recovery run before escalating to an operator. */
  maxAutoAttemptsPerRun: 3,
  escalationRecipient: 'Founder',
  escalationChannel: 'Not sent: this prototype sends no external messages.',
};

export const REFUND_RULES = [
  'If the funding deadline passes before the target is reached, every contribution is returned in full.',
  'If the operator cancels before the miner starts, every contribution is returned in full.',
  'After the miner starts, contributions pay for compute. Money already spent is not refundable.',
  'When the campaign ends (term complete or ended early), unspent budget is returned pro rata to contributors, separately from the amounts spent.',
  'Reward rights earned during the operating period survive the campaign ending, including rewards that arrive or unlock later.',
];

export const ALLOCATION_RULE_TEXT =
  'Allocation = your funded contribution ÷ total funded amount. Single fixed term; no duration bonus (not yet agreed). Allocations freeze when funding closes.';
