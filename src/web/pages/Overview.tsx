import type { viewHome } from '../../domain/views';
import { date, pct, until } from '../format';
import { CAMPAIGN_TONE, Check, Loading, OPS_TONE, Pill, Progress, Usd, Flop, useApp, useView } from '../ui';

type Home = ReturnType<typeof viewHome>;

export function Overview() {
  const { navigate, setRole } = useApp();
  const { data, error } = useView<Home>('home');
  if (!data) return <Loading error={error} />;
  return (
    <div className="stack-lg">
      <section className="hero">
        <div>
          <span className="eyebrow">Fixed, fully funded mining campaigns</span>
          <h1 style={{ marginTop: 6 }}>Fund part of a managed miner. Own a defined share of what it actually earns.</h1>
          <p className="lede">
            Each campaign has a fixed budget and term. Contributions pay for GPU time. When it is fully funded, allocations freeze and we run the miner,
            replace failed machines, and distribute your share of the rewards it actually receives, including rewards that unlock later.
          </p>
        </div>
        <div className="card card-tight stack" style={{ gap: 8 }}>
          <span className="eyebrow">Your simulated wallet</span>
          <div className="spread">
            <span className="muted">USDC</span>
            <span className="big" style={{ fontSize: 20 }}><Usd units={data.wallet.usdcUnits} /></span>
          </div>
          <div className="spread">
            <span className="muted">FLOP claimed</span>
            <span className="big" style={{ fontSize: 20 }}><Flop units={data.wallet.flopUnits} /></span>
          </div>
          {data.claimableUnits > 0n ? (
            <button className="btn btn-sm" onClick={() => navigate({ name: 'portfolio' })}>
              <Flop units={data.claimableUnits} /> claimable → My positions
            </button>
          ) : null}
        </div>
      </section>

      <div className="grid-main">
        <div className="stack">
          {data.campaigns.map((c) => (
            <article key={c.id} className="card campaign-card">
              <div className="spread">
                <div className="row">
                  <Pill tone={CAMPAIGN_TONE[c.status]}>{c.statusLabel}</Pill>
                  {c.status === 'running' || c.status === 'ended' ? <Pill tone={OPS_TONE[c.opsStatus]}>{c.opsLabel}</Pill> : null}
                </div>
                <span className="small faint mono">{c.id} · miner {c.minerId}</span>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <h2>{c.name}</h2>
                <p className="muted">{c.summary}</p>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <Progress value={c.fundedUnits} max={c.targetUnits} />
                <div className="spread small">
                  <span>
                    <Usd units={c.fundedUnits} /> of <Usd units={c.targetUnits} /> funded ({c.fundedPercent}%)
                  </span>
                  {c.status === 'funding' ? (
                    <strong className="num">
                      <Usd units={c.remainingUnits} /> remaining
                    </strong>
                  ) : null}
                </div>
              </div>
              <div className="facts">
                <div className="fact"><span className="eyebrow">Minimum</span><span className="v"><Usd units={c.minContributionUnits} /></span></div>
                <div className="fact">
                  <span className="eyebrow">Funding deadline</span>
                  <span className="v">{date(c.fundingDeadline)}</span>
                  {c.status === 'funding' ? <span className="sub">{until(data.clock, c.fundingDeadline)}</span> : null}
                </div>
                <div className="fact">
                  <span className="eyebrow">Operating term</span>
                  <span className="v">{c.termDays} days</span>
                  {c.startedAt ? <span className="sub">{date(c.startedAt)} → {date(c.endedAt ?? c.termEndsAt)}</span> : <span className="sub">starts after funding closes</span>}
                </div>
                <div className="fact"><span className="eyebrow">Contributors</span><span className="v">{c.contributorCount}</span></div>
              </div>
              <div className="spread">
                {c.my && c.my.contributedUnits > 0n ? (
                  <span className="small">
                    You contributed <Usd units={c.my.contributedUnits} /> ·{' '}
                    {c.my.allocationFrozen ? <strong>allocation {pct(c.my.allocationPercent)} (frozen)</strong> : <>provisional share {pct(c.my.allocationPercent)}</>}
                  </span>
                ) : (
                  <span className="small muted">You have no position in this campaign.</span>
                )}
                <button className={`btn ${c.status === 'funding' ? 'btn-primary' : ''}`} onClick={() => navigate({ name: 'campaign', id: c.id })}>
                  {c.status === 'funding' ? 'View and contribute' : 'View campaign'}
                </button>
              </div>
            </article>
          ))}
        </div>

        <aside className="stack">
          <section className="card">
            <div className="card-head">
              <h3>Try the full journey</h3>
              <span className="small muted num">{data.journey.completed}/{data.journey.steps.length}</span>
            </div>
            <ul className="clean checklist">
              {data.journey.steps.map((s) => (
                <li key={s.key}>
                  <Check done={s.done} />
                  <div>
                    <div style={{ fontWeight: 500 }}>{s.title}</div>
                    <div className="small muted">
                      <span className={s.role === 'operator' ? 'role-tag op' : 'role-tag'}>{s.role === 'operator' ? 'Operator' : 'Participant'}</span>
                      {!s.done ? ` ${s.hint}` : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="section row">
              <button className="btn btn-sm" onClick={() => navigate({ name: 'campaign', id: 'C-001' })}>Open Campaign 1</button>
              <button className="btn btn-sm" onClick={() => { setRole('operator'); navigate({ name: 'operator', id: 'C-001' }); }}>Switch to operator</button>
            </div>
          </section>
          <section className="card stack" style={{ gap: 10 }}>
            <h3>What a contribution buys</h3>
            <ul className="bullets small">
              <li>A frozen percentage of the rewards this campaign actually receives.</li>
              <li>Rights that continue after the campaign ends, including rewards that unlock later.</li>
              <li>Unspent budget returned pro rata when the campaign ends.</li>
            </ul>
            <h3>What it does not promise</h3>
            <ul className="bullets small">
              <li>No fixed return, profit, minimum airdrop or token price.</li>
              <li>No instant liquidity. Money spent on compute is not refundable.</li>
            </ul>
            <button className="btn-link small" style={{ alignSelf: 'start' }} onClick={() => navigate({ name: 'about' })}>
              How it works and who is responsible for what →
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}
