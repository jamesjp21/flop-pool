// HTTP integration: the acceptance journey through the real server, then a restart.

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decode, encode } from '../src/domain/serialize';
import { Service } from '../src/domain/service';
import { createApp } from '../src/server/app';
import { SqliteStore } from '../src/server/sqliteStore';

const dir = mkdtempSync(join(tmpdir(), 'flop-pool-api-'));
const dbFile = join(dir, 'api.db');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function boot(opts: { operatorToken?: string } = {}) {
  const store = new SqliteStore(dbFile);
  const service = await Service.open(store, { demoEnabled: true });
  const server: Server = createApp(service, { operatorToken: opts.operatorToken });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  };
  return { base, stop, service };
}

type Role = 'participant' | 'operator' | 'demo';
function client(base: string, token?: string) {
  let n = 0;
  const headers = (role: Role) => ({ 'Content-Type': 'application/json', 'X-Demo-Role': role, ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  return {
    async view(name: string, q: Record<string, string> = {}) {
      const r = await fetch(`${base}/api/views/${name}?${new URLSearchParams(q)}`);
      return { status: r.status, body: decode<any>(await r.text()) };
    },
    async cmd(role: Role, type: string, input: Record<string, unknown> = {}, idempotencyKey = `api-${type}-${++n}-${Date.now()}`) {
      const r = await fetch(`${base}/api/commands`, { method: 'POST', headers: headers(role), body: encode({ type, input, idempotencyKey }) });
      return { status: r.status, body: decode<any>(await r.text()) };
    },
  };
}

describe('HTTP API journey', () => {
  let snapshot = '';
  let entitlementId = '';

  it('runs the acceptance journey over HTTP', async () => {
    const { base, stop } = await boot();
    const api = client(base);
    try {
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      const home = await api.view('home');
      expect(home.body.campaigns[0].remainingUnits).toBe(600_000_000n);

      for (const [amount, code] of [['abc', 'INVALID_AMOUNT'], ['50', 'BELOW_MINIMUM'], ['601', 'EXCEEDS_REMAINING']] as const) {
        const r = await api.cmd('participant', 'contribution.submit', { campaignId: 'C-001', amount });
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe(code);
      }
      const topUpByParticipant = await api.cmd('participant', 'demo.topUp', { userId: 'u-demo', amount: '5' });
      expect(topUpByParticipant.status).toBe(403);

      const ok = await api.cmd('participant', 'contribution.submit', { campaignId: 'C-001', amount: '600' }, 'api-final-contribution');
      expect(ok.status).toBe(201);
      expect(ok.body.result.fundingClosed).toBe(true);
      entitlementId = ok.body.result.entitlementId;
      const dup = await api.cmd('participant', 'contribution.submit', { campaignId: 'C-001', amount: '600' }, 'api-final-contribution');
      expect(dup.status).toBe(200);
      expect(dup.body.duplicate).toBe(true);

      expect((await api.cmd('participant', 'campaign.start', { campaignId: 'C-001' })).status).toBe(403);
      expect((await api.cmd('operator', 'campaign.start', { campaignId: 'C-001' })).body.result.opsStatus).toBe('healthy');
      await api.cmd('demo', 'demo.advanceClock', { hours: 12 });
      expect((await api.cmd('demo', 'demo.injectFailure', { campaignId: 'C-001' })).body.result.opsStatus).toBe('healthy');
      const second = await api.cmd('demo', 'demo.injectFailure', { campaignId: 'C-001' });
      expect(second.body.result.opsStatus).toBe('manual_intervention');
      const op = await api.view('operator');
      expect(op.body.incidents[0].status).toBe('open');

      const camp = (await api.view('campaign', { id: 'C-001' })).body;
      const rec = await api.cmd('operator', 'reward.recordReceipt', {
        minerId: 'M-01', kind: 'airdrop', amount: '2000', earnedFrom: camp.card.startedAt, earnedTo: camp.clock, externalRef: 'api-airdrop-1',
      });
      expect(rec.status).toBe(201);
      const c1 = await api.cmd('participant', 'claim.submit', { entitlementId }, 'api-claim-1');
      expect(c1.body.result.units).toBe(100n * 10n ** 18n); // 20% of 500 liquid
      const c1again = await api.cmd('participant', 'claim.submit', { entitlementId }, 'api-claim-1');
      expect(c1again.body.duplicate).toBe(true);
      const c2 = await api.cmd('participant', 'claim.submit', { entitlementId });
      expect(c2.body.error.code).toBe('NOTHING_TO_CLAIM');

      await api.cmd('operator', 'reward.recordUnlock', { receiptId: rec.body.result.receiptId, amount: '500', externalRef: 'api-unlock-1' });
      const port = (await api.view('portfolio')).body;
      const pos = port.positions.find((p: any) => p.campaign.id === 'C-001');
      expect(pos.rewards.claimableUnits).toBe(100n * 10n ** 18n);
      expect(pos.rewards.lockedShareUnits).toBe(200n * 10n ** 18n);

      const end = await api.cmd('operator', 'campaign.end', { campaignId: 'C-001' });
      expect(end.status).toBe(201);
      const ledger = (await api.view('ledger')).body;
      expect(ledger.invariants.every((x: any) => x.ok)).toBe(true);
      const audit = (await api.view('audit', { campaignId: 'C-001', limit: '500' })).body;
      expect(audit.rows.some((r: any) => r.type === 'incident.opened')).toBe(true);
      expect(audit.rows.some((r: any) => r.type === 'refund.issued')).toBe(true);
      snapshot = encode((await api.view('portfolio')).body);
    } finally {
      await stop();
    }
  });

  it('serves the same state after a server restart', async () => {
    const { base, stop } = await boot();
    try {
      const api = client(base);
      expect(encode((await api.view('portfolio')).body)).toBe(snapshot);
      const r = await api.cmd('participant', 'claim.submit', { entitlementId }, 'api-claim-1');
      expect(r.body.duplicate).toBe(true);
    } finally {
      await stop();
    }
  });

  it('requires the operator token for operator and demo actions when configured', async () => {
    const { base, stop } = await boot({ operatorToken: 'secret-token-for-test' });
    try {
      const anon = client(base);
      expect((await anon.cmd('operator', 'campaign.start', { campaignId: 'C-002' })).status).toBe(403);
      expect((await anon.cmd('demo', 'demo.advanceClock', { hours: 1 })).status).toBe(403);
      const authed = client(base, 'secret-token-for-test');
      expect((await authed.cmd('demo', 'demo.advanceClock', { hours: 1 })).status).toBe(201);
      const bad = await fetch(`${base}/api/commands`, { method: 'POST', body: '{not json' });
      expect(bad.status).toBe(400);
    } finally {
      await stop();
    }
  });
});
