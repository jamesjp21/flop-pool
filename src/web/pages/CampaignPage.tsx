import { useMemo, useState } from 'react';
import { DomainError } from '../../domain/errors';
import { formatAmount, parsePositiveAmount, percentString } from '../../domain/money';
import type { viewCampaign } from '../../domain/views';
import { date, dateTime, duration, pct, until, usd, usdInput } from '../format';
import { CAMPAIGN_TONE, Flop, Loading, OPS_TONE, Pill, Progress, Sim, Usd, useApp, useCommand, useView } from '../ui';

type CampaignView = NonNullable<ReturnType<typeof viewCampaign>>;

function validate(v: CampaignView, raw: string): { units?: bigint; error?: string } {
  if (raw.trim() === '') return {};
  let units: bigint;
  try {
    units = parsePositiveAmount(raw.trim(), 'USDC', 'contribution');
  } catch (e) {
    return { error: e instanceof DomainError ? e.message : 'Enter a valid amount.' };
  }
  const remaining = v.funding.remainingUnits;
  const min = v.terms.minContributionUnits;
  if (units > remaining) return { units, error: `Only ${usd(remaining)} is left to fund. Contribute ${usd(remaining)} or less.` };
  if (units < min && units !== remaining) {
    return {
      units,
      error: remaining < min ? `Only ${usd(remaining)} is left. Contribute exactly that amount to complete funding.` : `The minimum contribution is ${usd(min)}.`,
    };
  }
  if (units > v.viewer.wallet.usdcUnits) return { units, error: `Your simulated wallet holds ${usd(v.viewer.wallet.usdcUnits)}.` };
  return { units };
}

function ContributeForm({ v }: { v: CampaignView }) {
  const [raw, setRaw] = useState('');
  const { run, busy } = useCommand();
  const check = useMemo(() => validate(v, raw), [v, raw]);
  const remaining = v.funding.remainingUnits;
  const target = v.terms.targetUnits;
  const mine = v.viewer.contributedUnits;
  const after = check.units && !check.error ? mine + check.units : undefined;
  const closes = check.units !== undefined && !check.error && check.units === remaining;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!check.units || check.error) return;
    try {
      await run('participant', 'contribution.submit', { campaignId: v.card.id, amount: raw.trim() }, (r: any) =>
        r.fundingClosed ? `Contributed ${usd(r.amountUnits)}. Funding is complete: your allocation is frozen at ${pct(r.allocationPercent, 4)}.` : `Contributed ${usd(r.amountUnits)}.`,
      );
      setRaw('');
    } catch {
      /* toast shown */
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="contrib-amount">Contribution amount</label>
        <div className="input-group">
          <input
            id="contrib-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={usdInput(v.terms.minContributionUnits)}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            aria-invalid={Boolean(check.error)}
            aria-describedby="contrib-help"
          />
          <span className="suffix">USDC&nbsp;<Sim>sim</Sim></span>
        </div>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => setRaw(usdInput(v.terms.minContributionUnits < remaining ? v.terms.minContributionUnits : remaining))}>
            Minimum
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setRaw(usdInput(remaining < v.viewer.wallet.usdcUnits ? remaining : v.viewer.wallet.usdcUnits))}>
            Fill remaining ({usd(remaining)})
          </button>
          <span className="small muted">Wallet: <Usd units={v.viewer.wallet.usdcUnits} /></span>
        </div>
        <div id="contrib-help" aria-live="polite">
          {check.error ? <div className="field-error">{check.error}</div> : null}
        </div>
      </div>

      {after !== undefined ? (
        <div className="callout">
          {closes ? (
            <>
              <strong>This contribution completes funding.</strong> Allocations freeze immediately: yours will be{' '}
              <strong className="num">{pct(percentString(after, target, 4), 4)}</strong> ({usd(after)} of {usd(target)}).
            </>
          ) : (
            <>
              Your share once the campaign is fully funded: <strong className="num">{pct(percentString(after, target, 4), 4)}</strong> ({usd(after)} of {usd(target)}).
              It is provisional until funding closes; if the target is not reached by {date(v.terms.fundingDeadline)}, the full amount is returned.
            </>
          )}
        </div>
      ) : null}

      <div className="row">
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !check.units || Boolean(check.error)}>
          {busy ? 'Submitting…' : check.units && !check.error ? `Contribute ${usd(check.units)}` : 'Contribute'}
        </button>
        <span className="small muted">Simulated transfer from your demo wallet. No real funds move.</span>
      </div>
    </form>
  );
}

export function CampaignPage({ id }: { id: string }) {
  const { navigate } = useApp();
  const { data: v, error } = useView<CampaignView>('campaign', { id });
  if (!v) return <Loading error={error} />;
  const c = v.card;
  const costTotal = v.terms.costLines.reduce((t, l) => t + l.units, 0n);

  return (
    <div className="stack-lg">
      <div className="stack" style={{ gap: 8 }}>
        <button className="btn-link small" style={{ alignSelf: 'start' }} onClick={() => navigate({ name: 'overview' })}>← All campaigns</button>
        <div className="row">
          <Pill tone={CAMPAIGN_TONE[c.status]}>{c.statusLabel}</Pill>
          {c.status !== 'funding' && c.status !== 'cancelled' && c.status !== 'funding_failed' ? <Pill tone={OPS_TONE[v.ops.status]}>{v.ops.label}</Pill> : null}
          <span className="small faint mono">{c.id}</span>
        </div>
        <h1>{c.name}</h1>
        <p className="muted" style={{ maxWidth: '70ch' }}>{c.summary}</p>
      </div>

      <div className="grid-main">
        <div className="stack-lg">
          <section className="card stack">
            <div className="card-head">
              <h2>Funding</h2>
              <span className="small muted">
                {c.status === 'funding' ? <>Deadline {dateTime(v.terms.fundingDeadline)} · {until(v.clock, v.terms.fundingDeadline)}</> : v.funding.closedAt ? <>Closed {dateTime(v.funding.closedAt)}</> : null}
              </span>
            </div>
            <Progress value={c.fundedUnits} max={c.targetUnits} />
            <div className="facts">
              <div className="fact"><span className="eyebrow">Target</span><span className="v"><Usd units={c.targetUnits} /></span></div>
              <div className="fact"><span className="eyebrow">Funded</span><span className="v"><Usd units={c.fundedUnits} /></span></div>
              <div className="fact"><span className="eyebrow">Remaining</span><span className="v"><Usd units={c.remainingUnits} /></span></div>
              <div className="fact"><span className="eyebrow">Minimum</span><span className="v"><Usd units={c.minContributionUnits} /></span></div>
              <div className="fact"><span className="eyebrow">Term</span><span className="v">{c.termDays} days</span></div>
            </div>
            {v.funding.open ? (
              <div className="section">
                <ContributeForm v={v} />
              </div>
            ) : (
              <div className="callout">
                {c.status === 'cancelled' || c.status === 'funding_failed'
                  ? 'This campaign did not operate. Every contribution was returned in full.'
                  : 'Funding is closed. Allocations are frozen and no new contributions are accepted.'}
              </div>
            )}
          </section>

          <section className="card stack">
            <h2>What the contributions pay for</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Budget line</th><th className="r">Amount</th><th className="hide-sm" style={{ width: '28%' }}>Share</th></tr>
                </thead>
                <tbody>
                  {v.terms.costLines.map((l) => (
                    <tr key={l.key}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{l.label}</div>
                        <div className="small muted">{l.note}</div>
                      </td>
                      <td className="r num">{usd(l.units)}</td>
                      <td className="hide-sm">{costTotal > 0n && l.units > 0n ? <div className="costbar" style={{ width: `${Number((l.units * 100n) / costTotal)}%` }} /> : <span className="small muted">—</span>}</td>
                    </tr>
                  ))}
                  <tr><td><strong>Total operating budget</strong></td><td className="r num"><strong>{usd(costTotal)}</strong></td><td className="hide-sm" /></tr>
                </tbody>
              </table>
            </div>
            <div className="callout small">
              <strong>Not paid from this budget:</strong> the miner stake of {formatAmount(v.miner.stakeRequiredUnits, 'FLOP')} base self-stake plus a runtime-calculated
              exposure bond. Who supplies it is <strong>unresolved</strong>. Future mainnet inference needed to unlock a historical airdrop is also not funded by this
              campaign; your entitlement to such unlocks is kept regardless.
            </div>
            <p className="small muted">Prices come from a simulated GPU marketplace and are illustrative. Unspent budget is returned pro rata when the campaign ends.</p>
          </section>

          <section className="card stack">
            <h2>Rules</h2>
            <div className="grid-2">
              <div className="stack" style={{ gap: 6 }}>
                <h3>Allocation</h3>
                <p className="small">{v.terms.allocationRuleText}</p>
                <h3 style={{ marginTop: 8 }}>Hardware</h3>
                <p className="small">{v.terms.hardware.description}. Tier: {v.terms.hardware.tier}.</p>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <h3>Cancellation and refunds</h3>
                <ul className="bullets small">
                  {v.terms.refundRules.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </div>
            </div>
            <div className="section grid-2">
              <div className="stack" style={{ gap: 6 }}>
                <h3>We are responsible for</h3>
                <ul className="bullets small">
                  <li>Recording and honouring allocations exactly as frozen.</li>
                  <li>Finding machines, deploying, monitoring and replacing them as described.</li>
                  <li>Distributing the rewards we actually receive, under these rules.</li>
                </ul>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <h3>Not promised</h3>
                <ul className="bullets small">
                  <li>Any fixed return, profitability, minimum airdrop or token price.</li>
                  <li>Instant liquidity, or return of money already spent on compute.</li>
                  <li>Protocol outcomes: FLOP determines rewards, unlocks and slashing.</li>
                </ul>
              </div>
            </div>
          </section>

          <section className="card stack">
            <div className="card-head">
              <h2>Contributors</h2>
              <span className="small muted">{v.funding.contributors.some((x) => x.frozen) ? 'Allocations frozen' : 'Shares are provisional until funding closes'}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Participant</th><th className="r">Contributed</th><th className="r">{v.funding.contributors.some((x) => x.frozen) ? 'Allocation' : 'Current share'}</th></tr></thead>
                <tbody>
                  {v.funding.contributors.map((x) => (
                    <tr key={x.label} className={x.isViewer ? 'selected' : ''}>
                      <td>{x.label}</td>
                      <td className="r num">{usd(x.units)}</td>
                      <td className="r num">{pct(x.percent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="stack">
          <section className="card stack">
            <h3>Your position</h3>
            {v.viewer.contributedUnits > 0n ? (
              <>
                <dl className="kv">
                  <dt>Contributed</dt><dd><Usd units={v.viewer.contributedUnits} /></dd>
                  <dt>{v.viewer.entitlement ? 'Allocation (frozen)' : 'Provisional share'}</dt>
                  <dd>{v.viewer.entitlement ? pct(v.viewer.entitlement.percent, 4) : pct(percentString(v.viewer.contributedUnits, c.fundedUnits, 4), 4)}</dd>
                  {v.viewer.entitlement ? (<><dt>Claimable now</dt><dd><Flop units={v.viewer.entitlement.claimableUnits} /></dd></>) : null}
                </dl>
                <button className="btn btn-sm" onClick={() => navigate({ name: 'portfolio' })}>Open My positions</button>
              </>
            ) : (
              <p className="small muted">You have not contributed to this campaign.</p>
            )}
          </section>

          <section className="card stack">
            <div className="card-head"><h3>Miner</h3><Pill tone={OPS_TONE[v.ops.status]}>{v.ops.label}</Pill></div>
            <dl className="kv small">
              <dt>Miner account</dt><dd>{v.miner.id}</dd>
              <dt>Tier</dt><dd>{v.miner.tier}</dd>
              {v.ops.machine ? (
                <>
                  <dt>Machine</dt><dd>{v.ops.machine.gpuModel}</dd>
                  <dt>Provider</dt><dd>{v.ops.machine.provider}</dd>
                  <dt>Rate</dt><dd>{usd(v.ops.machine.hourlyUnits)}/h</dd>
                  <dt>Running since</dt><dd>{dateTime(v.ops.machine.since)}</dd>
                </>
              ) : null}
              <dt>Replacements</dt><dd>{v.ops.replacements}</dd>
              <dt>Downtime</dt><dd>{duration(v.ops.downtimeMs)}</dd>
              {v.card.startedAt ? (<><dt>Term</dt><dd>{date(v.card.startedAt)} → {date(v.card.endedAt ?? v.card.termEndsAt)}</dd></>) : null}
            </dl>
            {v.ops.openIncidents > 0 ? <div className="callout callout-bad small">The miner is down and an operator is handling it. The term keeps running during downtime.</div> : null}
            <p className="small faint">Machines and health events are simulated. Miner account {v.miner.id} is reused by {v.miner.reusedByCampaigns.join(', ')}; each campaign earns only from its own operating window.</p>
          </section>

          <section className="card stack">
            <h3>Operating budget</h3>
            <dl className="kv small">
              <dt>Funded</dt><dd>{usd(v.budget.fundedUnits)}</dd>
              <dt>Spent: GPU rental</dt><dd>{usd(v.budget.spentByKind.gpu_rental)}</dd>
              <dt>Spent: setup fees</dt><dd>{usd(v.budget.spentByKind.setup_fee)}</dd>
              <dt>Still in budget</dt><dd>{usd(v.budget.remainingUnits)}</dd>
              <dt>Returned unused</dt><dd>{usd(v.budget.refundedUnits)}</dd>
            </dl>
            {v.budget.settlement ? (
              <div className="callout callout-ok small">
                Settled {date(v.budget.settlement.at)}: <span className="num">{usd(v.budget.settlement.spentUnits)}</span> spent,{' '}
                <span className="num">{usd(v.budget.settlement.unusedUnits)}</span> returned. Platform fee: {usd(v.budget.settlement.fee.usdcUnits)} ({v.budget.settlement.fee.note})
              </div>
            ) : null}
          </section>

          <section className="card stack">
            <h3>Campaign rewards</h3>
            <dl className="kv small">
              <dt>Received (attributed)</dt><dd><Flop units={v.rewards.receivedUnits} /></dd>
              <dt>Still locked</dt><dd><Flop units={v.rewards.lockedRemainingUnits} /></dd>
              <dt>Unlocked / distributable</dt><dd><Flop units={v.rewards.distributableUnits} /></dd>
              <dt>Credited to holders</dt><dd><Flop units={v.rewards.creditedUnits} /></dd>
              <dt>Claimed</dt><dd><Flop units={v.rewards.claimedUnits} /></dd>
              <dt>Rounding residual</dt><dd className="small">{v.rewards.residualUnits.toString()} base units</dd>
            </dl>
            <p className="small faint">Reward receipts here are entered by an operator in the simulator. No FLOP network is connected.</p>
          </section>

          <details className="card">
            <summary>FLOP protocol assumptions (unverified)</summary>
            <ul className="bullets small">
              <li>{v.protocol.source}</li>
              <li>Base miner self-stake: {formatAmount(v.protocol.baseMinerSelfStakeFlop, 'FLOP')} + {v.protocol.capacityExposureBond.toLowerCase()}</li>
              <li>{v.protocol.softTierNote}</li>
              <li>{v.protocol.settlementNote}</li>
              <li>{v.protocol.rewardSettlementNote}</li>
              <li>{v.protocol.slashingNote}</li>
              <li>Airdrop (draft): 25% liquid at genesis; {v.protocol.airdropDraft.unlockRule} {v.protocol.airdropDraft.status}</li>
            </ul>
          </details>
        </aside>
      </div>
    </div>
  );
}
