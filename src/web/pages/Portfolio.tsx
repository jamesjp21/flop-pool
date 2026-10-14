import type { viewPortfolio } from '../../domain/views';
import { date, dateTime, flp, pct, usd } from '../format';
import { CAMPAIGN_TONE, Flop, Loading, OPS_TONE, Pill, RewardBar, Sim, Usd, useApp, useCommand, useView } from '../ui';

type PortfolioView = ReturnType<typeof viewPortfolio>;
type Position = PortfolioView['positions'][number];

function ClaimButton({ p }: { p: Position }) {
  const { run, busy } = useCommand();
  if (!p.entitlement) return null;
  const claimable = p.rewards.claimableUnits;
  return (
    <div className="stack" style={{ gap: 4, alignItems: 'flex-start' }}>
      <button
        className="btn btn-primary"
        disabled={busy || claimable === 0n}
        onClick={() =>
          run('participant', 'claim.submit', { entitlementId: p.entitlement!.id }, (r: any) => `Claimed ${flp(r.units)} to your simulated wallet (${r.simulatedTxRef}).`).catch(() => undefined)
        }
      >
        {busy ? 'Claiming…' : claimable > 0n ? <>Claim <Flop units={claimable} /></> : 'Nothing to claim'}
      </button>
      {claimable === 0n && p.rewards.lockedShareUnits > 0n ? (
        <span className="small muted">Your locked share becomes claimable only when it unlocks.</span>
      ) : null}
    </div>
  );
}

function PositionCard({ p }: { p: Position }) {
  const { navigate } = useApp();
  const c = p.campaign;
  return (
    <article className="card stack">
      <div className="spread">
        <div className="row">
          <Pill tone={CAMPAIGN_TONE[c.status]}>{c.statusLabel}</Pill>
          {c.startedAt ? <Pill tone={OPS_TONE[c.opsStatus]}>{c.opsLabel}</Pill> : null}
        </div>
        <button className="btn-link small" onClick={() => navigate({ name: 'campaign', id: c.id })}>Campaign details →</button>
      </div>
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div className="stack" style={{ gap: 2 }}>
          <h2>{c.name}</h2>
          <span className="small muted">
            {c.startedAt ? <>Operated {date(c.startedAt)} → {c.endedAt ? date(c.endedAt) : `${date(c.termEndsAt)} (planned)`}</> : `Funding deadline ${date(c.fundingDeadline)}`}
          </span>
        </div>
        <div className="stack" style={{ gap: 0, alignItems: 'flex-end' }}>
          <span className="eyebrow">{p.entitlement ? 'Your allocation · frozen' : p.state === 'refunded' ? 'Refunded' : 'Provisional share'}</span>
          <span className="big">{p.entitlement ? pct(p.entitlement.percent, 4) : pct(p.provisionalPercent, 4)}</span>
        </div>
      </div>

      {p.state === 'pending_funding' ? (
        <div className="callout small">
          Funding is still open. Your share is provisional and freezes when the campaign reaches its target. If the deadline passes first, you get the full{' '}
          {usd(p.contributedUnits)} back.
        </div>
      ) : null}

      <div className="grid-2">
        <div className="stack" style={{ gap: 8 }}>
          <h3>Money</h3>
          <dl className="kv small">
            <dt>Contributed</dt><dd>{usd(p.money.contributedUnits)}</dd>
            <dt>{p.money.spentBasis === 'final' ? 'Spent on operations (final)' : 'Your share of spend so far'}</dt>
            <dd>{p.money.spentBasis === 'none' ? '—' : usd(p.money.spentShareUnits)}</dd>
            <dt>Returned to you</dt><dd>{usd(p.money.refundedUnits)}</dd>
          </dl>
          {p.money.spentBasis === 'to_date' ? <span className="small faint">Unspent budget is returned when the campaign ends.</span> : null}
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <h3>Rewards</h3>
          {p.entitlement ? (
            <>
              <dl className="kv small">
                <dt>Your share of rewards received</dt><dd><Flop units={p.rewards.attributableReceivedUnits} /></dd>
                <dt>Locked (not claimable)</dt><dd><Flop units={p.rewards.lockedShareUnits} /></dd>
                <dt>Claimable</dt><dd><Flop units={p.rewards.claimableUnits} /></dd>
                <dt>Claimed</dt><dd><Flop units={p.rewards.claimedUnits} /></dd>
              </dl>
            </>
          ) : (
            <span className="small muted">Rewards accrue to allocations once funding closes and the miner runs.</span>
          )}
        </div>
      </div>

      {p.entitlement ? (
        <>
          <RewardBar claimed={p.rewards.claimedUnits} claimable={p.rewards.claimableUnits} locked={p.rewards.lockedShareUnits} />
          <div className="spread">
            <ClaimButton p={p} />
            <details className="small" style={{ maxWidth: 420 }}>
              <summary>Allocation record</summary>
              <dl className="kv">
                <dt>Allocation id</dt><dd>{p.entitlement.id}</dd>
                <dt>Share</dt><dd>{p.entitlement.shareNumerator.toString()} / {p.entitlement.shareDenominator.toString()}</dd>
                <dt>Frozen</dt><dd>{dateTime(p.entitlement.frozenAt)}</dd>
              </dl>
              <div className="section">
                <span className="eyebrow">Ownership history</span>
                <ul className="clean" style={{ marginTop: 6 }}>
                  {p.entitlement.ownership.map((o, i) => (
                    <li key={i}>{o.label} since {dateTime(o.from)} ({o.reason.replace('_', ' ')})</li>
                  ))}
                </ul>
                <p className="faint" style={{ marginTop: 6 }}>Transferring an allocation is not available in this version.</p>
              </div>
            </details>
          </div>
        </>
      ) : null}
    </article>
  );
}

export function Portfolio() {
  const { navigate } = useApp();
  const { data, error } = useView<PortfolioView>('portfolio');
  if (!data) return <Loading error={error} />;
  return (
    <div className="stack-lg">
      <div className="spread">
        <div className="stack" style={{ gap: 4 }}>
          <h1>My positions</h1>
          <p className="muted">Allocations, money spent and returned, and rewards: received, locked, claimable and claimed.</p>
        </div>
        <div className="card card-tight row" style={{ gap: 24 }}>
          <div className="stack" style={{ gap: 0 }}><span className="eyebrow">USDC wallet <Sim>sim</Sim></span><span className="big" style={{ fontSize: 20 }}><Usd units={data.wallet.usdcUnits} /></span></div>
          <div className="stack" style={{ gap: 0 }}><span className="eyebrow">FLOP wallet <Sim>sim</Sim></span><span className="big" style={{ fontSize: 20 }}><Flop units={data.wallet.flopUnits} /></span></div>
        </div>
      </div>

      {data.positions.length === 0 ? (
        <div className="empty stack" style={{ alignItems: 'center' }}>
          <p>You have no positions yet. Campaign 1 has 600 USDC left to fund.</p>
          <button className="btn btn-primary" onClick={() => navigate({ name: 'campaign', id: 'C-001' })}>Open Campaign 1</button>
        </div>
      ) : (
        data.positions.map((p) => <PositionCard key={p.campaign.id} p={p} />)
      )}

      <section className="card stack">
        <div className="card-head">
          <h2>Reward history</h2>
          <span className="small muted">Your share of each event. Amounts in FLOP (simulated).</span>
        </div>
        {data.history.length === 0 ? (
          <p className="small muted">No rewards yet. Receipts appear here once the operator records them for a campaign you hold.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Campaign</th><th>Event</th><th className="r">Your amount</th></tr></thead>
              <tbody>
                {data.history.map((h, i) => (
                  <tr key={i}>
                    <td className="num small">{dateTime(h.at)}</td>
                    <td className="mono small">{h.campaignId}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{h.title}</div>
                      <div className="small muted">{h.detail}</div>
                      {h.lockedUnits ? <div className="small flop">Of your share, {flp(h.lockedUnits)} arrived locked and is not claimable until it unlocks.</div> : null}
                    </td>
                    <td className="r">{h.units !== undefined ? <Flop units={h.units} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.refunds.length ? (
        <section className="card stack">
          <h2>Refunds</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Campaign</th><th>Reason</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {data.refunds.map((r) => (
                  <tr key={r.id}>
                    <td className="num small">{dateTime(r.at)}</td>
                    <td className="mono small">{r.campaignId}</td>
                    <td>{r.reason === 'unused_budget' ? 'Unused operating budget' : r.reason === 'funding_failed' ? 'Funding deadline missed' : 'Campaign cancelled'}</td>
                    <td className="r num">{usd(r.units)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
