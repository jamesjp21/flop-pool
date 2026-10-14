import { useState } from 'react';
import { formatAmount } from '../../domain/money';
import type { viewAudit, viewLedger } from '../../domain/views';
import { dateTime } from '../format';
import { Loading, Pill, useView } from '../ui';

type AuditView = ReturnType<typeof viewAudit>;
type LedgerView = ReturnType<typeof viewLedger>;

const ACTOR_TONE: Record<string, 'accent' | 'ok' | 'warn' | 'flop' | 'demo' | 'neutral'> = {
  participant: 'accent',
  operator: 'warn',
  orchestrator: 'ok',
  rewards: 'flop',
  settlement: 'accent',
  system: 'neutral',
  demo: 'demo',
  seed: 'neutral',
};

export function Audit() {
  const [campaignId, setCampaignId] = useState('');
  const [withCommands, setWithCommands] = useState(false);
  const [tab, setTab] = useState<'events' | 'ledger'>('events');
  const audit = useView<AuditView>('audit', { campaignId: campaignId || undefined, limit: '400', includeCommands: withCommands ? '1' : undefined });
  const ledger = useView<LedgerView>('ledger');
  const home = useView<{ campaigns: { id: string }[] }>('home');
  const failing = ledger.data?.invariants.filter((x) => !x.ok) ?? [];
  return (
    <div className="stack-lg">
      <div className="spread">
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Operator console</span>
          <h1>Audit log and ledger</h1>
          <p className="muted">Every change is an append-only event. Money moves only as balanced double-entry postings.</p>
        </div>
        {ledger.data ? (
          <Pill tone={failing.length ? 'bad' : 'ok'}>{failing.length ? `${failing.length} invariant(s) failing` : `All ${ledger.data.invariants.length} ledger checks pass`}</Pill>
        ) : null}
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'events'} onClick={() => setTab('events')}>Events</button>
        <button role="tab" aria-selected={tab === 'ledger'} onClick={() => setTab('ledger')}>Ledger balances and checks</button>
      </div>

      {tab === 'events' ? (
        <section className="card stack">
          <div className="row">
            <div className="field" style={{ minWidth: 160 }}>
              <label htmlFor="a-c">Campaign</label>
              <select id="a-c" className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">All</option>
                {(home.data?.campaigns ?? []).map((c: { id: string }) => <option key={c.id} value={c.id}>{c.id}</option>)}
              </select>
            </div>
            <label className="row small" style={{ gap: 6, alignSelf: 'end', minHeight: 36 }}>
              <input type="checkbox" checked={withCommands} onChange={(e) => setWithCommands(e.target.checked)} /> Show idempotency records
            </label>
            {audit.data ? <span className="small muted" style={{ alignSelf: 'end', minHeight: 36, display: 'flex', alignItems: 'center' }}>{audit.data.total} events in the log</span> : null}
          </div>
          {!audit.data ? (
            <Loading error={audit.error} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th className="r">#</th><th>Demo time</th><th>Actor</th><th>Event</th><th>Postings</th></tr>
                </thead>
                <tbody>
                  {audit.data.rows.map((r) => (
                    <tr key={r.seq}>
                      <td className="r mono small faint">{r.seq}</td>
                      <td className="small num">{dateTime(r.at)}</td>
                      <td><Pill tone={ACTOR_TONE[r.actorKind] ?? 'neutral'} plain>{r.actorKind}</Pill></td>
                      <td>
                        <div className="mono small faint">{r.type}{r.campaignId ? ` · ${r.campaignId}` : ''}</div>
                        <div>{r.summary}</div>
                      </td>
                      <td className="small">
                        {r.postings.length ? (
                          <ul className="clean" style={{ gap: 2 }}>
                            {r.postings.map((p, i) => (
                              <li key={i} className="mono" style={{ fontSize: 11.5 }}>
                                {formatAmount(p.amount, p.asset)} <span className="faint">{p.from} → {p.to}</span>
                              </li>
                            ))}
                          </ul>
                        ) : <span className="faint">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : !ledger.data ? (
        <Loading error={ledger.error} />
      ) : (
        <div className="grid-main">
          <section className="card stack">
            <div className="card-head"><h2>Account balances</h2><span className="small muted">{ledger.data.postingCount} postings</span></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Account</th><th className="r">USDC (sim)</th><th className="r">FLOP (sim)</th></tr></thead>
                <tbody>
                  {ledger.data.accounts.map((a) => (
                    <tr key={a.account}>
                      <td className="mono small">{a.account}{a.external ? <span className="faint"> · external</span> : null}</td>
                      <td className="r num small">{a.usdcUnits ? formatAmount(a.usdcUnits, 'USDC', { symbol: false }) : '—'}</td>
                      <td className="r num small">{a.flopUnits ? formatAmount(a.flopUnits, 'FLOP', { symbol: false }) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">External accounts are counterparties (simulated faucet, providers, protocol, stake supplier) and may be negative. Internal accounts never are. Campaign and allocation accounts are book entries; real tokens would sit in an operator-controlled wallet, which is custodial.</p>
          </section>
          <section className="card stack">
            <h2>Invariant checks</h2>
            <ul className="clean small">
              {ledger.data.invariants.map((x) => (
                <li key={x.name} className="spread">
                  <span>{x.ok ? '✓' : '✗'} {x.name}</span>
                  <span className="faint mono" style={{ fontSize: 11 }}>{x.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
