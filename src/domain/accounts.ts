// Ledger accounts and the posting policy.
//
// Accounts prefixed `external:` represent counterparties outside the platform's
// books (simulated faucet, simulated provider, the FLOP protocol, the stake
// supplier). Their balances may go negative. Every other account must stay >= 0.
//
// "campaign:*" and "entitlement:*" accounts are internal book entries. In a real
// deployment the underlying tokens would sit in an operator-controlled wallet,
// which is custodial.

import type { ActorKind } from './types';
import type { Asset } from './money';

export const acct = {
  faucet: 'external:demo-faucet',
  protocol: 'external:flop-protocol',
  stakeSupplier: 'external:stake-supplier',
  slashed: 'external:slashed',
  provider: (providerId: string) => `external:provider:${providerId}`,
  wallet: (userId: string) => `user:${userId}:wallet`,
  budget: (campaignId: string) => `campaign:${campaignId}:budget`,
  rewardsLocked: (campaignId: string) => `campaign:${campaignId}:rewards-locked`,
  rewardsUndistributed: (campaignId: string) => `campaign:${campaignId}:rewards-undistributed`,
  claimable: (entitlementId: string) => `entitlement:${entitlementId}:claimable`,
  unattributedLocked: (minerId: string) => `miner:${minerId}:unattributed-locked`,
  unattributedUnlocked: (minerId: string) => `miner:${minerId}:unattributed-unlocked`,
  stake: (minerId: string) => `miner:${minerId}:stake`,
  platformFees: 'platform:fees',
};

export function isExternal(account: string): boolean {
  return account.startsWith('external:');
}

interface PolicyRule {
  asset: Asset;
  from: RegExp;
  to: RegExp;
  actors: ActorKind[];
  purpose: string;
}

/**
 * Which actor may move which asset between which accounts.
 *
 * The orchestrator (GPU automation) can only pay simulated providers from a
 * campaign's budget. It cannot touch reward accounts, refunds, wallets, or stake.
 * The rewards service can only move FLOP along receipt -> locked -> undistributed
 * -> claimable -> holder wallet. Settlement can only return USDC from a campaign
 * budget to wallets.
 */
export const POSTING_POLICY: PolicyRule[] = [
  { asset: 'USDC', from: /^external:demo-faucet$/, to: /^user:[^:]+:wallet$/, actors: ['demo', 'seed'], purpose: 'Simulated USDC top-up' },
  { asset: 'USDC', from: /^user:[^:]+:wallet$/, to: /^campaign:[^:]+:budget$/, actors: ['participant'], purpose: 'Contribution' },
  { asset: 'USDC', from: /^campaign:[^:]+:budget$/, to: /^external:provider:[^:]+$/, actors: ['orchestrator'], purpose: 'Compute expenditure' },
  { asset: 'USDC', from: /^campaign:[^:]+:budget$/, to: /^user:[^:]+:wallet$/, actors: ['settlement'], purpose: 'Refund' },
  { asset: 'USDC', from: /^campaign:[^:]+:budget$/, to: /^platform:fees$/, actors: ['settlement'], purpose: 'Platform fee (unconfigured)' },
  { asset: 'FLOP', from: /^external:flop-protocol$/, to: /^campaign:[^:]+:rewards-(locked|undistributed)$/, actors: ['rewards'], purpose: 'Reward receipt' },
  { asset: 'FLOP', from: /^external:flop-protocol$/, to: /^miner:[^:]+:unattributed-(locked|unlocked)$/, actors: ['rewards'], purpose: 'Unattributed reward receipt' },
  { asset: 'FLOP', from: /^campaign:[^:]+:rewards-locked$/, to: /^campaign:[^:]+:rewards-undistributed$/, actors: ['rewards'], purpose: 'Unlock' },
  { asset: 'FLOP', from: /^miner:[^:]+:unattributed-locked$/, to: /^miner:[^:]+:unattributed-unlocked$/, actors: ['rewards'], purpose: 'Unattributed unlock' },
  { asset: 'FLOP', from: /^campaign:[^:]+:rewards-undistributed$/, to: /^entitlement:[^:]+:claimable$/, actors: ['rewards'], purpose: 'Distribution credit' },
  { asset: 'FLOP', from: /^entitlement:[^:]+:claimable$/, to: /^user:[^:]+:wallet$/, actors: ['rewards'], purpose: 'Claim payout' },
  { asset: 'FLOP', from: /^external:stake-supplier$/, to: /^miner:[^:]+:stake$/, actors: ['seed', 'operator'], purpose: 'Stake recorded' },
  { asset: 'FLOP', from: /^miner:[^:]+:stake$/, to: /^external:slashed$/, actors: ['demo', 'operator'], purpose: 'Slash (stake only)' },
];

export function findPolicy(asset: Asset, from: string, to: string, actor: ActorKind): PolicyRule | undefined {
  return POSTING_POLICY.find((r) => r.asset === asset && r.from.test(from) && r.to.test(to) && r.actors.includes(actor));
}
