// Authority separation: the GPU orchestrator, the rewards service and settlement
// each hold only the ledger rights they need.

import { describe, expect, it } from 'vitest';
import { acct } from '../src/domain/accounts';
import { Tx } from '../src/domain/engine';
import { DomainError } from '../src/domain/errors';
import { usdc, flop } from '../src/domain/money';
import type { Actor } from '../src/domain/types';
import { ME, seededEngine } from './helpers';

function attempt(actor: Actor, posting: { asset: 'USDC' | 'FLOP'; from: string; to: string; amount: bigint }) {
  const e = seededEngine();
  const tx = new Tx(structuredClone(e.state), actor, 'policy-test-key', '2026-10-14T00:00:00.000Z');
  try {
    tx.emit('wallet.topped_up', { userId: 'x', units: posting.amount }, [{ ...posting, memo: 'policy test' }]);
    return 'allowed';
  } catch (err) {
    if (err instanceof DomainError && err.code === 'POLICY_VIOLATION') return 'denied';
    throw err;
  }
}

const orchestrator: Actor = { kind: 'orchestrator', id: 'svc' };
const rewards: Actor = { kind: 'rewards', id: 'svc' };
const settlement: Actor = { kind: 'settlement', id: 'svc' };

describe('posting policy', () => {
  it('lets the orchestrator pay a provider from a campaign budget, and nothing else', () => {
    expect(attempt(orchestrator, { asset: 'USDC', from: acct.budget('C-001'), to: acct.provider('sim-a'), amount: usdc('1') })).toBe('allowed');
    expect(attempt(orchestrator, { asset: 'USDC', from: acct.budget('C-001'), to: acct.wallet('u-demo'), amount: usdc('1') })).toBe('denied');
    expect(attempt(orchestrator, { asset: 'USDC', from: acct.wallet('u-avery'), to: acct.provider('sim-a'), amount: usdc('1') })).toBe('denied');
    expect(attempt(orchestrator, { asset: 'FLOP', from: acct.stake('M-01'), to: acct.slashed, amount: flop('1') })).toBe('denied');
    expect(attempt(orchestrator, { asset: 'FLOP', from: acct.protocol, to: acct.rewardsUndistributed('C-001'), amount: flop('1') })).toBe('denied');
  });

  it('keeps reward distribution away from USDC and settlement away from FLOP', () => {
    expect(attempt(rewards, { asset: 'USDC', from: acct.budget('C-001'), to: acct.provider('sim-a'), amount: usdc('1') })).toBe('denied');
    expect(attempt(rewards, { asset: 'USDC', from: acct.budget('C-001'), to: acct.wallet('u-demo'), amount: usdc('1') })).toBe('denied');
    expect(attempt(settlement, { asset: 'FLOP', from: acct.rewardsUndistributed('C-001'), to: acct.wallet('u-demo'), amount: flop('1') })).toBe('denied');
    expect(attempt(settlement, { asset: 'USDC', from: acct.budget('C-001'), to: acct.provider('sim-a'), amount: usdc('1') })).toBe('denied');
  });

  it('lets a participant spend only from their own wallet', () => {
    expect(attempt(ME, { asset: 'USDC', from: acct.wallet('u-demo'), to: acct.budget('C-001'), amount: usdc('1') })).toBe('allowed');
    expect(attempt(ME, { asset: 'USDC', from: acct.wallet('u-avery'), to: acct.budget('C-001'), amount: usdc('1') })).toBe('denied');
  });

  it('never lets an internal account go negative', () => {
    const e = seededEngine();
    const tx = new Tx(structuredClone(e.state), orchestrator, 'policy-test-key-2', '2026-10-14T00:00:00.000Z');
    expect(() =>
      tx.emit('wallet.topped_up', {}, [{ asset: 'USDC', from: acct.budget('C-001'), to: acct.provider('sim-a'), amount: usdc('2400.000001'), memo: 'overdraw' }]),
    ).toThrow(/negative/);
  });
});
