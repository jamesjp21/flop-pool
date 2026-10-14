import { useEffect, useMemo, useState } from 'react';
import { POSTING_POLICY } from '../../domain/accounts';
import { formatAmount } from '../../domain/money';
import type { viewOperator } from '../../domain/views';
import { date, dateTime, duration, flopInput, KIND_LABEL, pct, usd } from '../format';
import { CAMPAIGN_TONE, ConfirmButton, Flop, Loading, OPS_TONE, Pill, Sim, Usd, useApp, useCommand, useView } from '../ui';

type OperatorView = ReturnType<typeof viewOperator>;
type CampaignOps = OperatorView['campaigns'][number];

const DEP_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'neutral'> = { running: 'ok', failed: 'bad', deploy_failed: 'bad', requested: 'warn', terminated: 'neutral' };
const DEP_LABEL: Record<string, string> = { running: 'Running', failed: 'Failed (health)', deploy_failed: 'Failed to start', requested: 'Requested', terminated: 'Terminated' };

export function OperatorConsole({ id }: { id?: string }) {
  const { navigate } = useApp();
  const { data, error } = useView<OperatorView>('operator');
  if (!data) return <Loading error={error} />;
  const selected = data.campaigns.find((c) => c.card.id === id) ?? data.campaigns.find((c) => c.card.status === 'running') ?? data.campaigns[0];
  const open = data.incidents.filter((i) => i.status !== 'resolved');
  return (
    <div className="stack-lg">
      <div className="spread">
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Operator console</span>
          <h1>Campaign operations</h1>
        </div>
        <div className="row small muted">
          Simulated market: <Pill tone={data.marketMode === 'normal' ? 'neutral' : 'bad'}>{data.marketMode.replace('_', ' ')}</Pill>
        </div>
      </div>

      {open.length ? (
        <div className="callout callout-bad">
          <strong>{open.length} open incident{open.length > 1 ? 's' : ''} need{open.length > 1 ? '' : 's'} an operator.</strong>{' '}
          {open.map((i) => `${i.id} (${i.campaignId}): ${i.title}`).join(' · ')}. Escalation recipient: {data.orchestration.escalationRecipient}. {data.orchestration.escalationChannel}
        </div>
      ) : null}

      <div className="tabs" role="tablist">
        {data.campaigns.map((c) => (
          <button key={c.card.id} role="tab" aria-selected={c.card.id === selected?.card.id} onClick={() => navigate({ name: 'operator', id: c.card.id })}>
            {c.card.id} · {c.card.statusLabel.split(' ·')[0]}
            {c.card.openIncidents ? ' ⚠' : ''}
          </button>
        ))}
      </div>

      {selected ? <CampaignOpsView c={selected} data={data} /> : null}

      <div className="grid-2">
        <DemoControls data={data} c={selected} />
        <div className="stack">
          <MinerPanel data={data} />
          <NewCampaign data={data} />
        </div>
      </div>
      <Boundaries data={data} />
    </div>
  );
}

function CampaignOpsView({ c, data }: { c: CampaignOps; data: OperatorView }) {
  const { run, busy } = useCommand();
  const card = c.card;
  return (
    <div className="stack-lg">
      <section className="card stack">
        <div className="spread">
          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <Pill tone={CAMPAIGN_TONE[card.status]}>{card.statusLabel}</Pill>
              <Pill tone={OPS_TONE[c.ops.status]}>{c.ops.label}</Pill>
            </div>
            <h2>{card.name}</h2>
          </div>
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={busy || !c.actions.canStart}
              title={c.actions.canStart ? '' : 'Only a fully funded campaign can start'}
              onClick={() => run('operator', 'campaign.start', { campaignId: card.id }, (r: any) => (r.opsStatus === 'healthy' ? `Started ${card.id}; miner healthy on ${r.activeDeploymentId}.` : `Started ${card.id}; miner needs an operator.`)).catch(() => undefined)}
            >
              Start campaign
            </button>
            <ConfirmButton
              label="End campaign"
              confirmLabel="End now and settle"
              prompt="Stops the miner, settles spend, returns unused budget."
              className="btn btn-danger"
              disabled={!c.actions.canEnd}
              onConfirm={() => run('operator', 'campaign.end', { campaignId: card.id, reason: 'Ended by operator' }, `Ended ${card.id}. Unused budget returned; reward rights continue.`)}
            />
            <ConfirmButton
              label="Cancel campaign"
              confirmLabel="Cancel and refund all"
              prompt="Only before start. Every contribution is returned."
              className="btn btn-danger"
              disabled={!c.actions.canCancel}
              onConfirm={() => run('operator', 'campaign.cancel', { campaignId: card.id, reason: 'Cancelled by operator' }, `Cancelled ${card.id}; contributions refunded in full.`)}
            />
          </div>
        </div>
        <div className="facts">
          <div className="fact"><span className="eyebrow">Funded</span><span className="v">{usd(card.fundedUnits)} / {usd(card.targetUnits)}</span></div>
          <div className="fact"><span className="eyebrow">Spent</span><span className="v">{usd(c.spentUnits)}</span></div>
          <div className="fact"><span className="eyebrow">Budget left</span><span className="v">{usd(c.budgetRemainingUnits)}</span></div>
          <div className="fact"><span className="eyebrow">Returned</span><span className="v">{usd(c.refundedUnits)}</span></div>
          <div className="fact"><span className="eyebrow">Term</span><span className="v">{card.startedAt ? `${date(card.startedAt)} → ${date(card.endedAt ?? card.termEndsAt)}` : `${card.termDays} d, not started`}</span></div>
          <div className="fact"><span className="eyebrow">Downtime</span><span className="v">{duration(c.ops.downtimeMs)}</span></div>
        </div>
      </section>

      {c.incidents.length ? <Incidents c={c} data={data} /> : null}

      <Selection c={c} data={data} />

      <div className="grid-main">
        <div className="stack-lg">
          <Deployments c={c} />
          <Rewards c={c} data={data} />
        </div>
        <div className="stack-lg">
          <Allocations c={c} />
          <Budget c={c} />
        </div>
      </div>
    </div>
  );
}

function Incidents({ c, data }: { c: CampaignOps; data: OperatorView }) {
  const { run, busy } = useCommand();
  const [offerId, setOfferId] = useState('');
  const preview = c.marketPreview;
  const candidates = preview ? preview.checks.filter((x) => x.reasons.every((r) => /earlier/.test(r))) : [];
  return (
    <section className="stack">
      {c.incidents.slice().reverse().map((i) => (
        <article key={i.id} className={`card incident${i.status === 'resolved' ? ' resolved' : ''} stack`}>
          <div className="spread">
            <div className="row">
              <Pill tone={i.status === 'resolved' ? 'ok' : 'bad'}>{i.status === 'resolved' ? 'Resolved' : i.status === 'acknowledged' ? 'Acknowledged' : 'Open'}</Pill>
              <strong>{i.id}</strong>
              <span className="small muted">{dateTime(i.openedAt)}</span>
            </div>
            <span className="small muted">Escalate to {i.escalation.recipient} · {i.escalation.channel}</span>
          </div>
          <h3>{i.title}</h3>
          <p className="small">{i.detail}</p>
          {i.attempts.length ? (
            <ul className="bullets small">
              {i.attempts.map((a) => <li key={a.deploymentId}>{a.deploymentId} on {a.offerId}: {a.outcome}</li>)}
            </ul>
          ) : null}
          {i.status !== 'resolved' ? (
            <div className="row">
              {i.status === 'open' ? (
                <button className="btn btn-sm" disabled={busy} onClick={() => run('operator', 'incident.acknowledge', { incidentId: i.id }, `${i.id} acknowledged.`).catch(() => undefined)}>Acknowledge</button>
              ) : null}
              {c.actions.canRetry ? (
                <>
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run('operator', 'ops.retryRecovery', { campaignId: c.card.id }, (r: any) => (r.opsStatus === 'healthy' ? `Recovered on ${r.activeDeploymentId}.` : 'Recovery failed again; incident stays open.')).catch(() => undefined)}>
                    Retry automated recovery
                  </button>
                  <span className="row" style={{ gap: 6 }}>
                    <select className="input" style={{ width: 'auto', minHeight: 30 }} value={offerId} onChange={(e) => setOfferId(e.target.value)} aria-label="Offer to deploy">
                      <option value="">Choose an offer…</option>
                      {candidates.map((x) => (
                        <option key={x.offerId} value={x.offerId}>{x.offerId} · {data.offers.find((o) => o.id === x.offerId)?.gpuModel} · {usd(x.estimatedTotalUnits)}</option>
                      ))}
                    </select>
                    <button className="btn btn-sm" disabled={busy || !offerId} onClick={() => run('operator', 'ops.retryRecovery', { campaignId: c.card.id, offerId }, (r: any) => (r.opsStatus === 'healthy' ? `Deployed ${offerId}; miner healthy.` : 'Deployment failed; see timeline.')).catch(() => undefined)}>
                      Deploy chosen offer
                    </button>
                  </span>
                </>
              ) : null}
              <button
                className="btn btn-sm"
                disabled={busy || (c.card.status === 'running' && c.ops.status !== 'healthy' && i.kind !== 'miner_blacklisted')}
                title={c.ops.status !== 'healthy' ? 'Restore a healthy machine or end the campaign first' : ''}
                onClick={() => run('operator', 'incident.resolve', { incidentId: i.id, note: 'Resolved from operator console' }, `${i.id} resolved.`).catch(() => undefined)}
              >
                Resolve
              </button>
            </div>
          ) : (
            <p className="small muted">Resolved {dateTime(i.resolvedAt)}: {i.resolutionNote}</p>
          )}
          {c.actions.canRetry && candidates.length === 0 ? (
            <p className="small muted">No offer meets the hard requirements right now. In Simulation controls, set the market to normal or add simulated capacity, then retry.</p>
          ) : null}
        </article>
      ))}
    </section>
  );
}

function Selection({ c, data }: { c: CampaignOps; data: OperatorView }) {
  const [mode, setMode] = useState<'last' | 'now'>(c.lastEvaluation ? 'last' : 'now');
  useEffect(() => setMode(c.lastEvaluation ? 'last' : 'now'), [c.card.id, c.lastEvaluation?.id]);
  const ev = mode === 'last' && c.lastEvaluation ? c.lastEvaluation : undefined;
  const checks = ev ? ev.checks : c.marketPreview?.checks ?? [];
  const hours = ev ? ev.remainingHours : c.marketPreview?.hours;
  const selectedId = ev ? ev.selectedOfferId : c.marketPreview?.selected?.offerId;
  const rows = checks
    .map((x) => ({ x, o: data.offers.find((o) => o.id === x.offerId)! }))
    .filter((r) => r.o)
    .sort((a, b) => (a.x.rank ?? 99) - (b.x.rank ?? 99) || (a.o.hourlyUnits < b.o.hourlyUnits ? -1 : 1));
  return (
    <section className="card stack">
      <div className="card-head">
        <div className="stack" style={{ gap: 2 }}>
          <h2>Provider selection</h2>
          <span className="small muted">Hard requirements first, then lowest reliability-adjusted total cost. <Sim>simulated offers</Sim></span>
        </div>
        {c.lastEvaluation ? (
          <div className="segmented" role="group" aria-label="Evaluation">
            <button aria-pressed={mode === 'last'} onClick={() => setMode('last')}>Last decision</button>
            <button aria-pressed={mode === 'now'} onClick={() => setMode('now')} disabled={!c.marketPreview}>Market now</button>
          </div>
        ) : null}
      </div>
      <p className="small">
        Requirement: {c.terms.hardware.description}.
        {ev ? <> Evaluated {dateTime(ev.at)} for <strong>{ev.purpose.replace('_', ' ')}</strong> with {ev.remainingHours} h left and a budget of {usd(ev.budgetUnits)}; market mode “{ev.marketMode.replace('_', ' ')}”.</> : hours !== undefined ? <> Preview for the remaining {hours} h.</> : null}
      </p>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Offer</th><th>GPU</th><th className="r">$/h</th><th className="r">Reliability</th><th>Type</th><th className="r">Est. total</th><th>Decision</th></tr>
            </thead>
            <tbody>
              {rows.map(({ x, o }) => (
                <tr key={o.id} className={o.id === selectedId ? 'selected' : x.eligible ? '' : 'ineligible'}>
                  <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{o.id}<div className="faint">{o.providerLabel.replace('Simulated marketplace', 'Market')} · {o.region}</div></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{o.gpuModel}<div className="small faint">{o.vramGb} GB · {o.verifiedHost ? 'verified' : 'unverified'} host</div></td>
                  <td className="r num">{formatAmount(o.hourlyUnits, 'USDC', { symbol: false })}</td>
                  <td className="r num">{(o.reliabilityBps / 100).toFixed(1)}%</td>
                  <td className="small">{o.interruptible ? 'Spot' : 'On-demand'}</td>
                  <td className="r num">{formatAmount(x.estimatedTotalUnits, 'USDC', { symbol: false })}</td>
                  <td className="small">
                    {o.id === selectedId ? <Pill tone="accent">Selected</Pill> : x.eligible ? <span>Eligible #{x.rank}</span> : <span className="muted">{x.reasons.join('; ')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">Selection runs when a funded campaign starts.</p>
      )}
    </section>
  );
}

function Deployments({ c }: { c: CampaignOps }) {
  if (!c.deployments.length) return null;
  return (
    <section className="card stack">
      <div className="card-head">
        <h2>Machines and health</h2>
        <span className="small muted">Deployments and failures are simulated. Downtime is not treated as fraud.</span>
      </div>
      <ul className="clean timeline">
        {c.deployments.slice().reverse().map((d) => (
          <li key={d.id}>
            <span className="when small muted num">{dateTime(d.requestedAt)}</span>
            <div className="stack" style={{ gap: 2 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="mono" style={{ fontWeight: 500 }}>{d.id}</span>
                <span>{d.offer.gpuModel} · {d.offer.id}</span>
                <Pill tone={DEP_TONE[d.status]}>{DEP_LABEL[d.status]}</Pill>
              </div>
              <span className="small muted">
                {d.purpose.replace('_', ' ')} · attempt {d.attempt} · {usd(d.offer.hourlyUnits)}/h
                {d.runningAt ? ` · ran ${dateTime(d.runningAt)} → ${d.endedAt ? dateTime(d.endedAt) : 'now'}` : ''}
              </span>
              {d.failure ? <span className="small" style={{ color: 'var(--bad)' }}>{d.failure.detail}</span> : null}
            </div>
            <span className="num small">{usd(d.rentalCostUnits + d.setupFeeUnits)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function defaultRef(prefix: string) {
  return `sim-${prefix}-${Date.now().toString(36)}`;
}

function Rewards({ c, data }: { c: CampaignOps; data: OperatorView }) {
  const { run, busy } = useCommand();
  const miner = data.miners.find((m) => m.id === c.card.minerId)!;
  const windowFrom = c.card.startedAt;
  const windowTo = c.card.endedAt ?? data.clock;
  const [kind, setKind] = useState('block_reward');
  const [amount, setAmount] = useState('1000');
  const [liquid, setLiquid] = useState('');
  const [from, setFrom] = useState(windowFrom ?? data.clock);
  const [to, setTo] = useState(windowTo);
  const [ref, setRef] = useState(defaultRef('receipt'));
  useEffect(() => {
    setFrom(c.card.startedAt ?? data.clock);
    setTo(c.card.endedAt ?? data.clock);
  }, [c.card.id, c.card.startedAt, c.card.endedAt, data.clock]);
  const receipts = data.receipts.filter((r) => r.minerId === miner.id);
  const firstWindow = miner.windows[0]?.from;

  const record = async (e: React.FormEvent) => {
    e.preventDefault();
    await run(
      'operator',
      'reward.recordReceipt',
      { minerId: miner.id, kind, amount: amount.trim(), liquidAmount: liquid.trim() || undefined, earnedFrom: from.trim(), earnedTo: to.trim(), externalRef: ref.trim(), note: 'Simulated receipt entered in operator console' },
      (r: any) => `Recorded ${r.receiptId}: ${r.lots.map((l: any) => `${formatAmount(l.amountUnits, 'FLOP')} → ${l.campaignId ?? 'unattributed'}`).join(', ')}.`,
    ).catch(() => undefined);
    setRef(defaultRef('receipt'));
  };

  return (
    <section className="card stack">
      <div className="card-head">
        <div className="stack" style={{ gap: 2 }}>
          <h2>Rewards</h2>
          <span className="small muted">Record what actually reached miner {miner.id}. Attribution follows each campaign's operating window. <Sim>operator-entered</Sim></span>
        </div>
      </div>
      <dl className="kv small">
        <dt>Attributed to {c.card.id}</dt><dd><Flop units={c.rewards.receivedUnits} /></dd>
        <dt>Locked</dt><dd><Flop units={c.rewards.lockedRemainingUnits} /></dd>
        <dt>Credited · claimed</dt><dd><Flop units={c.rewards.creditedUnits} /> · <Flop units={c.rewards.claimedUnits} /></dd>
        <dt>Residual (rounding)</dt><dd>{c.rewards.residualUnits.toString()} base units</dd>
      </dl>
      <form className="stack section" onSubmit={record}>
        <h3>Record a reward receipt</h3>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="r-kind">Type</label>
            <select id="r-kind" className="input" value={kind} onChange={(e) => { setKind(e.target.value); setLiquid(''); }}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="r-amount">Amount received (FLOP)</label>
            <input id="r-amount" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="r-liquid">Liquid now (FLOP)</label>
            <input id="r-liquid" className="input mono" inputMode="decimal" placeholder={kind === 'airdrop' ? '25% (draft design)' : 'All of it'} value={liquid} onChange={(e) => setLiquid(e.target.value)} />
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="r-from">Earned from (UTC)</label>
            <input id="r-from" className="input mono small" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="r-to">Earned to (UTC)</label>
            <input id="r-to" className="input mono small" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="r-ref">On-chain / provider reference</label>
            <input id="r-ref" className="input mono small" value={ref} onChange={(e) => setRef(e.target.value)} />
          </div>
        </div>
        <div className="row small">
          <span className="muted">Earning period:</span>
          {windowFrom ? <button type="button" className="btn btn-sm" onClick={() => { setFrom(windowFrom); setTo(windowTo); }}>{c.card.id} window</button> : null}
          <button type="button" className="btn btn-sm" onClick={() => { setFrom(new Date(Date.parse(data.clock) - 86_400_000).toISOString()); setTo(data.clock); }}>Last 24 h</button>
          {firstWindow ? <button type="button" className="btn btn-sm" onClick={() => { setFrom(firstWindow); setTo(data.clock); }}>Since the miner first ran</button> : null}
        </div>
        <div className="row">
          <button className="btn btn-primary" disabled={busy}>Record receipt</button>
          <span className="small muted">The same reference can never be recorded twice.</span>
        </div>
      </form>

      {receipts.length ? (
        <div className="section stack">
          <h3>Receipts on {miner.id}</h3>
          {receipts.map((r) => <ReceiptRow key={r.id} r={r} />)}
        </div>
      ) : null}
    </section>
  );
}

function ReceiptRow({ r }: { r: OperatorView['receipts'][number] }) {
  const { run, busy } = useCommand();
  const remaining = r.lockedUnits - r.unlockedUnits;
  const [amount, setAmount] = useState(flopInput(remaining < r.lockedUnits / 2n ? remaining : r.lockedUnits / 2n));
  const [ref, setRef] = useState(defaultRef('unlock'));
  return (
    <div className="card card-tight stack" style={{ boxShadow: 'none', gap: 8 }}>
      <div className="spread">
        <div className="row" style={{ gap: 8 }}>
          <span className="mono" style={{ fontWeight: 500 }}>{r.id}</span>
          <span>{KIND_LABEL[r.kind]}</span>
          <Flop units={r.amountUnits} />
          {r.lockedUnits > 0n ? <Pill tone="flop">{formatAmount(remaining, 'FLOP')} locked</Pill> : null}
        </div>
        <span className="small muted mono">{r.externalRef}</span>
      </div>
      <div className="small muted">
        Earned {dateTime(r.earnedFrom)} → {dateTime(r.earnedTo)} · lots:{' '}
        {r.lots.map((l) => `${l.campaignId ?? 'unattributed'} ${formatAmount(l.amountUnits, 'FLOP')}`).join(' · ')}
      </div>
      {r.unlocks.length ? <div className="small">Unlocks: {r.unlocks.map((u) => `${u.id} ${formatAmount(u.amountUnits, 'FLOP')} (${u.externalRef})`).join(' · ')}</div> : null}
      {remaining > 0n ? (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            await run('operator', 'reward.recordUnlock', { receiptId: r.id, amount: amount.trim(), externalRef: ref.trim() }, (x: any) => `Recorded ${x.unlockId}; credited to the campaign(s) that earned ${r.id}.`).catch(() => undefined);
            setRef(defaultRef('unlock'));
          }}
        >
          <label className="small muted" htmlFor={`u-${r.id}`}>Unlock</label>
          <input id={`u-${r.id}`} className="input mono small" style={{ width: 150 }} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className="input mono small" style={{ width: 190 }} aria-label="Unlock reference" value={ref} onChange={(e) => setRef(e.target.value)} />
          <button className="btn btn-sm" disabled={busy}>Record unlock</button>
        </form>
      ) : null}
    </div>
  );
}

function Allocations({ c }: { c: CampaignOps }) {
  return (
    <section className="card stack">
      <div className="card-head">
        <h3>{c.entitlements.length ? 'Frozen allocations' : 'Contributions'}</h3>
        <span className="small muted">{c.entitlements.length ? 'Pro rata to funded amount' : 'Allocations freeze when funded'}</span>
      </div>
      {c.entitlements.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Holder</th><th className="r">Share</th><th className="r">Credited</th><th className="r">Claimable</th></tr></thead>
            <tbody>
              {c.entitlements.map((e) => (
                <tr key={e.id}>
                  <td>{e.holderLabel}<div className="small faint mono">{e.id} · {usd(e.contributedUnits)}</div></td>
                  <td className="r num">{pct(e.percent, 2)}</td>
                  <td className="r"><Flop units={e.creditedUnits} max={2} /></td>
                  <td className="r"><Flop units={e.claimableUnits} max={2} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <details>
        <summary className="small">All contributions ({c.contributions.length})</summary>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Id</th><th>Participant</th><th className="r">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {c.contributions.map((x) => (
                <tr key={x.id}><td className="mono small">{x.id}</td><td>{x.label}</td><td className="r num">{usd(x.amountUnits)}</td><td className="small">{x.status.replace(/_/g, ' ')}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function Budget({ c }: { c: CampaignOps }) {
  const rental = c.expenditures.filter((x) => x.kind === 'gpu_rental').reduce((t, x) => t + x.units, 0n);
  const setup = c.expenditures.filter((x) => x.kind === 'setup_fee').reduce((t, x) => t + x.units, 0n);
  return (
    <section className="card stack">
      <h3>Budget</h3>
      <dl className="kv small">
        <dt>Funded</dt><dd>{usd(c.card.fundedUnits)}</dd>
        <dt>GPU rental</dt><dd>{usd(rental)}</dd>
        <dt>Setup fees ({c.expenditures.filter((x) => x.kind === 'setup_fee').length})</dt><dd>{usd(setup)}</dd>
        <dt>Remaining in budget</dt><dd>{usd(c.budgetRemainingUnits)}</dd>
        <div className="total" style={{ display: 'contents' }}><dt>Returned unused</dt><dd>{usd(c.refundedUnits)}</dd></div>
      </dl>
      {c.settlement ? <p className="small muted">Settled {dateTime(c.settlement.at)} ({c.settlement.reason}). Fee: {c.settlement.fee.note}</p> : null}
      {c.refunds.length ? (
        <details>
          <summary className="small">Refunds ({c.refunds.length})</summary>
          <ul className="clean small">
            {c.refunds.map((r) => <li key={r.id} className="spread"><span>{r.label}</span><span className="num">{usd(r.units)}</span></li>)}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function DemoControls({ data, c }: { data: OperatorView; c?: CampaignOps }) {
  const { run, busy } = useCommand();
  const { api, bump, toast } = useApp();
  const [failure, setFailure] = useState('host_unreachable');
  const [slash, setSlash] = useState('2500');
  const [blacklist, setBlacklist] = useState(false);
  const termHours = c?.card.status === 'running' && c.card.termEndsAt ? Math.max(1, Math.ceil((Date.parse(c.card.termEndsAt) - Date.parse(data.clock)) / 3_600_000)) : undefined;
  const deadlineHours = c?.card.status === 'funding' ? Math.max(1, Math.ceil((Date.parse(c.card.fundingDeadline) - Date.parse(data.clock)) / 3_600_000)) : undefined;
  const adv = (hours: number) => run('demo', 'demo.advanceClock', { hours }, (r: any) => `Demo clock now ${dateTime(r.clock)}.`).catch(() => undefined);
  const reserveLeft = ['O-109', 'O-110', 'O-111'].filter((id) => !data.offers.some((o) => o.id === id)).length;
  return (
    <section className="demo-panel stack">
      <div className="stack" style={{ gap: 2 }}>
        <h2>Simulation controls</h2>
        <span className="small">Demo-only. These stand in for time passing, hardware failing and provider markets changing. Customers never see them.</span>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">Clock · now {dateTime(data.clock)}</span>
        <div className="row">
          <button className="btn btn-demo btn-sm" disabled={busy} onClick={() => adv(1)}>+1 hour</button>
          <button className="btn btn-demo btn-sm" disabled={busy} onClick={() => adv(24)}>+1 day</button>
          <button className="btn btn-demo btn-sm" disabled={busy} onClick={() => adv(24 * 7)}>+7 days</button>
          {termHours ? <button className="btn btn-demo btn-sm" disabled={busy} onClick={() => adv(termHours)}>To {c!.card.id} term end</button> : null}
          {deadlineHours ? <button className="btn btn-demo btn-sm" disabled={busy} onClick={() => adv(deadlineHours)}>To {c!.card.id} funding deadline</button> : null}
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">Machine {c ? `· ${c.card.id}` : ''}</span>
        <div className="row">
          <select className="input" style={{ width: 'auto', minHeight: 30 }} value={failure} onChange={(e) => setFailure(e.target.value)} aria-label="Failure type">
            <option value="host_unreachable">Host unreachable</option>
            <option value="gpu_error">GPU error</option>
            <option value="miner_exited">Miner process exits</option>
          </select>
          <button className="btn btn-demo btn-sm" disabled={busy || !c?.actions.canFail} onClick={() => run('demo', 'demo.injectFailure', { campaignId: c!.card.id, kind: failure }, (r: any) => (r.opsStatus === 'healthy' ? `Failure handled: automation replaced the machine (${r.activeDeploymentId}).` : 'Automated recovery failed; an incident is open.')).catch(() => undefined)}>
            Simulate machine failure
          </button>
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">Simulated GPU market</span>
        <div className="row">
          <div className="segmented" role="group" aria-label="Market mode">
            {(['normal', 'deploy_outage', 'no_capacity'] as const).map((m) => (
              <button key={m} aria-pressed={data.marketMode === m} disabled={busy} onClick={() => run('demo', 'demo.setMarketMode', { mode: m }, `Market mode: ${m.replace('_', ' ')}.`).catch(() => undefined)}>
                {m === 'normal' ? 'Normal' : m === 'deploy_outage' ? 'Deploy outage' : 'No capacity'}
              </button>
            ))}
          </div>
          <button className="btn btn-demo btn-sm" disabled={busy || reserveLeft === 0} onClick={() => run('demo', 'demo.addCapacity', {}, (r: any) => `Offer ${r.offerId} is now in the simulated market.`).catch(() => undefined)}>
            Add capacity ({reserveLeft} left)
          </button>
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">Funding and wallets</span>
        <div className="row">
          <button className="btn btn-demo btn-sm" disabled={busy || !c?.actions.canFill} onClick={() => run('demo', 'demo.fillFunding', { campaignId: c!.card.id }, (r: any) => `${r.addedParticipants.length} simulated participants completed funding.`).catch(() => undefined)}>
            Fill {c?.card.id ?? ''} with simulated participants
          </button>
          <button className="btn btn-demo btn-sm" disabled={busy} onClick={() => run('demo', 'demo.topUp', { userId: 'u-demo', amount: '500' }, 'Added 500 simulated USDC to your demo wallet.').catch(() => undefined)}>
            +500 USDC to demo wallet
          </button>
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">Stake slashing (affects stake only)</span>
        <div className="row">
          <input className="input mono" style={{ width: 120 }} aria-label="Slash amount in FLOP" value={slash} onChange={(e) => setSlash(e.target.value)} />
          <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={blacklist} onChange={(e) => setBlacklist(e.target.checked)} /> blacklist miner</label>
          <button className="btn btn-demo btn-sm" disabled={busy} onClick={() => run('demo', 'demo.simulateSlash', { minerId: 'M-01', amount: slash.trim(), blacklist }, (r: any) => `Slashed ${formatAmount(r.slashedUnits, 'FLOP')} of M-01 stake. Participant rewards untouched.`).catch(() => undefined)}>
            Simulate proven-fraud slash
          </button>
        </div>
      </div>
      <div className="section row" style={{ borderTopColor: 'var(--demo)' }}>
        <ConfirmButton
          label="Reset demo"
          confirmLabel="Erase and re-seed"
          prompt="Discards every action and restores the seeded example."
          className="btn btn-demo btn-sm"
          onConfirm={async () => {
            await api.reset();
            bump();
            toast('Demo reset to the seeded example.');
          }}
        />
      </div>
    </section>
  );
}

function MinerPanel({ data }: { data: OperatorView }) {
  return (
    <section className="card stack">
      <h3>Miner accounts</h3>
      {data.miners.map((m) => (
        <div key={m.id} className="stack" style={{ gap: 8 }}>
          <div className="row"><span className="mono" style={{ fontWeight: 500 }}>{m.id}</span><Pill tone={m.status === 'active' ? 'ok' : 'bad'}>{m.status}</Pill><span className="small muted">{m.tier} tier · {m.currentCampaignId ? `operating ${m.currentCampaignId}` : 'idle'}</span></div>
          <dl className="kv small">
            <dt>Base self-stake required</dt><dd><Flop units={m.stake.requiredBaseUnits} max={0} /></dd>
            <dt>Stake recorded</dt><dd><Flop units={m.stakeBalanceUnits} max={2} /></dd>
            <dt>Slashed</dt><dd><Flop units={m.stake.slashedUnits} max={2} /></dd>
            <dt>Stake supplier</dt><dd>{m.stake.supplier}</dd>
            <dt>Unattributed (no campaign window)</dt><dd><Flop units={m.unattributedLockedUnits + m.unattributedUnlockedUnits} max={2} /></dd>
          </dl>
          <p className="small faint">{m.stake.supplierNote} Exposure bond: {m.stake.bondNote}</p>
          {m.windows.length ? (
            <div>
              <span className="eyebrow">Operating windows (attribution)</span>
              <ul className="clean small" style={{ marginTop: 6 }}>
                {m.windows.map((w) => <li key={w.campaignId} className="spread"><span className="mono">{w.campaignId}</span><span className="num">{dateTime(w.from)} → {w.to ? dateTime(w.to) : 'now'}</span></li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function NewCampaign({ data }: { data: OperatorView }) {
  const { run, busy } = useCommand();
  const n = data.campaigns.length + 1;
  const [name, setName] = useState(`Campaign ${n} · 80 GB GPU miner`);
  const [target, setTarget] = useState('3000');
  const [min, setMin] = useState('100');
  const [fundingDays, setFundingDays] = useState('14');
  const [termDays, setTermDays] = useState('30');
  useEffect(() => setName(`Campaign ${data.campaigns.length + 1} · 80 GB GPU miner`), [data.campaigns.length]);
  return (
    <details className="card">
      <summary>Create a campaign on M-01</summary>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run('operator', 'campaign.create', { name, minerId: 'M-01', target, minContribution: min, fundingDays: Number(fundingDays), termDays: Number(termDays) }, (r: any) => `Created ${r.campaignId}.`).catch(() => undefined);
        }}
      >
        <div className="field"><label htmlFor="nc-name">Name</label><input id="nc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="form-grid">
          <div className="field"><label htmlFor="nc-target">Target (USDC)</label><input id="nc-target" className="input mono" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
          <div className="field"><label htmlFor="nc-min">Minimum (USDC)</label><input id="nc-min" className="input mono" value={min} onChange={(e) => setMin(e.target.value)} /></div>
          <div className="field"><label htmlFor="nc-fd">Funding window (days)</label><input id="nc-fd" className="input mono" value={fundingDays} onChange={(e) => setFundingDays(e.target.value)} /></div>
          <div className="field"><label htmlFor="nc-td">Term (days)</label><input id="nc-td" className="input mono" value={termDays} onChange={(e) => setTermDays(e.target.value)} /></div>
        </div>
        <p className="small muted">Budget lines default to 84% GPU rental, 10% replacement reserve, 6% deployment, and 0 platform fee (unconfigured).</p>
        <button className="btn" disabled={busy}>Create campaign</button>
      </form>
    </details>
  );
}

function Boundaries({ data }: { data: OperatorView }) {
  const policy = useMemo(() => POSTING_POLICY.map((p) => ({ purpose: p.purpose, asset: p.asset, actors: p.actors.join(', ') })), []);
  return (
    <section className="card stack">
      <h2>Integration and authority boundaries</h2>
      <div className="grid-2">
        <div className="stack" style={{ gap: 8 }}>
          <h3>Provider adapters</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Adapter</th><th>Status</th><th>Credentials</th></tr></thead>
              <tbody>
                {data.adapters.map((a) => (
                  <tr key={a.id}>
                    <td>{a.label}</td>
                    <td>{a.implemented ? <Pill tone="demo">Simulated, active</Pill> : <Pill tone="neutral">Not implemented</Pill>}</td>
                    <td className="small mono">{a.implemented ? '—' : `${a.credentialEnv}: ${a.configured ? 'set (unused)' : 'missing'}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">No FLOP network, wallet, or GPU provider is contacted. Missing credentials disable only their adapter.</p>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <h3>Who may move what</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ledger movement</th><th>Asset</th><th>Allowed identity</th></tr></thead>
              <tbody>
                {policy.map((p) => <tr key={p.purpose + p.actors}><td>{p.purpose}</td><td className="mono small">{p.asset}</td><td className="small">{p.actors}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="small muted">The GPU orchestrator can only pay providers from a campaign budget. Reward distribution and refunds are separate identities.</p>
        </div>
      </div>
    </section>
  );
}
