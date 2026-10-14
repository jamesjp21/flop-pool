import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { acct } from '../src/domain/accounts';
import { DEMO } from '../src/domain/config';
import { DomainError } from '../src/domain/errors';
import { usdc } from '../src/domain/money';
import { encode } from '../src/domain/serialize';
import { Service } from '../src/domain/service';
import { balanceOf } from '../src/domain/state';
import { checkInvariants } from '../src/domain/views';
import { SqliteStore } from '../src/server/sqliteStore';
import { DEMO_ACTOR, ME, OP, key } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'flop-pool-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('14. state survives a restart (SQLite event store)', () => {
  const file = join(dir, 'restart.db');

  it('replays the persisted log into identical state', async () => {
    const store1 = new SqliteStore(file);
    const s1 = await Service.open(store1, { demoEnabled: true });
    expect(s1.state.campaigns['C-001'].fundedUnits).toBe(usdc('2400'));
    await s1.execute({ type: 'contribution.submit', input: { campaignId: 'C-001', amount: '600' }, idempotencyKey: key() }, ME);
    await s1.execute({ type: 'campaign.start', input: { campaignId: 'C-001' }, idempotencyKey: key() }, OP);
    await s1.execute({ type: 'demo.advanceClock', input: { hours: 30 }, idempotencyKey: key() }, DEMO_ACTOR);
    await s1.execute({ type: 'demo.injectFailure', input: { campaignId: 'C-001' }, idempotencyKey: key() }, DEMO_ACTOR);
    const c = s1.state.campaigns['C-001'];
    await s1.execute(
      { type: 'reward.recordReceipt', input: { minerId: 'M-01', kind: 'airdrop', amount: '1000', earnedFrom: c.startedAt, earnedTo: s1.state.clock, externalRef: 'sim-persist-1' }, idempotencyKey: key() },
      OP,
    );
    const claimKey = key('claim');
    const ent = s1.state.campaigns['C-001'].entitlementIds.map((id) => s1.state.entitlements[id]).find((x) => x.holderId === DEMO.demoUserId)!;
    await s1.execute({ type: 'claim.submit', input: { entitlementId: ent.id }, idempotencyKey: claimKey }, ME);
    const snapshot = encode(s1.state);
    store1.close();

    const store2 = new SqliteStore(file);
    const s2 = await Service.open(store2, { demoEnabled: true });
    expect(encode(s2.state)).toBe(snapshot);
    expect(checkInvariants(s2.state).filter((x) => !x.ok)).toEqual([]);
    // Idempotency survives the restart: replaying the claim pays nothing more.
    const before = balanceOf(s2.state, acct.wallet(DEMO.demoUserId), 'FLOP');
    const again = await s2.execute({ type: 'claim.submit', input: { entitlementId: ent.id }, idempotencyKey: claimKey }, ME);
    expect(again.duplicate).toBe(true);
    expect(balanceOf(s2.state, acct.wallet(DEMO.demoUserId), 'FLOP')).toBe(before);
    store2.close();
  });

  it('keeps a SQL-queryable ledger (exact TEXT amounts) that matches the replayed balances', async () => {
    // Amounts are stored as exact integer strings. FLOP base units (18 decimals) exceed
    // SQLite's 64-bit INTEGER, so sums are done in application code, not with SUM().
    const db = new DatabaseSync(file);
    const rows = db.prepare('SELECT asset, from_account, to_account, amount FROM postings').all() as { asset: 'USDC' | 'FLOP'; from_account: string; to_account: string; amount: string }[];
    db.close();
    const bal = new Map<string, bigint>();
    for (const r of rows) {
      bal.set(`${r.from_account}|${r.asset}`, (bal.get(`${r.from_account}|${r.asset}`) ?? 0n) - BigInt(r.amount));
      bal.set(`${r.to_account}|${r.asset}`, (bal.get(`${r.to_account}|${r.asset}`) ?? 0n) + BigInt(r.amount));
    }
    const store = new SqliteStore(file);
    const s = await Service.open(store, { demoEnabled: true });
    expect(bal.size).toBeGreaterThan(10);
    for (const [k, v] of bal) {
      const [account, asset] = k.split('|') as [string, 'USDC' | 'FLOP'];
      expect(v).toBe(balanceOf(s.state, account, asset));
    }
    store.close();
  });

  it('rejected commands write nothing', async () => {
    const store = new SqliteStore(join(dir, 'reject.db'));
    const s = await Service.open(store, { demoEnabled: true });
    const seq = s.state.seq;
    await expect(s.execute({ type: 'contribution.submit', input: { campaignId: 'C-001', amount: '5000' }, idempotencyKey: key() }, ME)).rejects.toBeInstanceOf(DomainError);
    expect(s.state.seq).toBe(seq);
    expect((await store.load()).length).toBe(seq);
    store.close();
  });

  it('serializes concurrent commands (no lost updates, no overfunding)', async () => {
    const store = new SqliteStore(join(dir, 'concurrent.db'));
    const s = await Service.open(store, { demoEnabled: true });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => s.execute({ type: 'contribution.submit', input: { campaignId: 'C-001', amount: '100' }, idempotencyKey: key() }, ME)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect(s.state.campaigns['C-001'].fundedUnits).toBe(usdc('3000'));
    expect(s.state.campaigns['C-001'].status).toBe('funded');
    store.close();
    const reopened = await Service.open(new SqliteStore(join(dir, 'concurrent.db')), { demoEnabled: true });
    expect(reopened.state.campaigns['C-001'].fundedUnits).toBe(usdc('3000'));
  });

  it('reset replaces the log with fresh seed data', async () => {
    const store = new SqliteStore(join(dir, 'reset.db'));
    const s = await Service.open(store, { demoEnabled: true });
    await s.execute({ type: 'contribution.submit', input: { campaignId: 'C-001', amount: '600' }, idempotencyKey: key() }, ME);
    await s.reset();
    expect(s.state.campaigns['C-001'].fundedUnits).toBe(usdc('2400'));
    const reopened = await Service.open(new SqliteStore(join(dir, 'reset.db')), { demoEnabled: true });
    expect(reopened.state.campaigns['C-001'].fundedUnits).toBe(usdc('2400'));
  });
});
