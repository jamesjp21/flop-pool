import { FEE_OPEN_QUESTIONS } from '../../domain/fees';

const CONCEPTS: [string, string][] = [
  ['Money spent renting compute', 'Campaign budget → simulated provider. Shown as “spent” and never refundable once spent.'],
  ['FLOP supplied as miner stake', 'Recorded on the miner account. Not paid from any campaign budget. Supplier unresolved.'],
  ['Campaign reward entitlements', 'Frozen allocations: a fixed share of eligible rewards, separate from tokens on hand.'],
  ['Tokens actually received', 'Reward receipts recorded against the miner account and attributed by operating window.'],
  ['Tokens locked or unavailable', 'The locked part of a receipt (e.g. 75% of an airdrop under the draft design).'],
  ['Tokens unlocked and claimable', 'Unlocked tokens credited to each allocation by its frozen share.'],
  ['Tokens already distributed', 'Claims paid to participant wallets. Never paid twice.'],
];

const LAUNCH = [
  'Choose a jurisdiction and get legal advice on whether reward shares are securities, collective investment, or another regulated activity.',
  'Decide custody: who holds contributions and reward tokens, under what agreements. An operator-controlled reward wallet is custodial.',
  'Customer eligibility, KYC/AML and sanctions screening; any licensing that applies.',
  'Customer contract and risk disclosures: fee model, what happens on slashing, protocol changes, and early termination.',
  'Agree the platform fee model (questions below) and duration incentives, if any.',
  'Decide who supplies the miner stake and capacity bond, and on what terms.',
  'Decide who pays for future mainnet inference that unlocks historical airdrops.',
  'Real integrations: stablecoin payments, FLOP miner runtime and settlement, GPU providers, monitoring, alerting to the founder.',
  'Security review, key management (separate GPU credentials from reward signing), and an independent accounting review.',
];

export function About() {
  return (
    <div className="stack-lg" style={{ maxWidth: 980 }}>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">How it works</span>
        <h1>Who does what, and what this prototype is</h1>
        <p className="muted" style={{ maxWidth: '68ch' }}>
          An independent prototype. It is not affiliated with or endorsed by the FLOP project. Every balance, machine, reward and transfer in it is simulated.
        </p>
      </div>
      <div className="grid-2">
        <section className="card stack">
          <h2>Responsibilities</h2>
          <dl className="kv" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <dt><strong style={{ color: 'var(--ink)' }}>FLOP protocol</strong></dt>
            <dd style={{ textAlign: 'left', fontFamily: 'var(--font-body)' }}>Determines rewards, unlocks, settlement, slashing and blacklisting.</dd>
            <dt><strong style={{ color: 'var(--ink)' }}>This service</strong></dt>
            <dd style={{ textAlign: 'left', fontFamily: 'var(--font-body)' }}>Runs campaigns: sources GPUs, deploys and monitors the miner, replaces failed machines, keeps the accounts, and distributes the rewards it actually receives under the campaign rules.</dd>
            <dt><strong style={{ color: 'var(--ink)' }}>Participants</strong></dt>
            <dd style={{ textAlign: 'left', fontFamily: 'var(--font-body)' }}>Choose a campaign and an amount, and claim rewards as they become distributable.</dd>
          </dl>
        </section>
        <section className="card stack">
          <h2>Seven things kept separate</h2>
          <ul className="clean small">
            {CONCEPTS.map(([k, v], i) => (
              <li key={k}><strong>{i + 1}. {k}.</strong> <span className="muted">{v}</span></li>
            ))}
          </ul>
        </section>
      </div>
      <div className="grid-2">
        <section className="card stack">
          <h2>Platform fee: not configured</h2>
          <p className="small">The working idea is about 5% of profit. That is not 5% of contributions or 5% of rewards, so the demo charges nothing until these are answered:</p>
          <ul className="bullets small">{FEE_OPEN_QUESTIONS.map((q) => <li key={q}>{q}</li>)}</ul>
        </section>
        <section className="card stack">
          <h2>Deliberately not built yet</h2>
          <ul className="bullets small">
            <li><strong>Trading allocations.</strong> A sale would move only the remaining entitlement. Claimed rewards never move; locked and credited-but-unclaimed rights need explicit rules. Ownership history is already recorded.</li>
            <li><strong>Slashing cover.</strong> Needs real capital, covered events, limits and claims rules. Nothing here implies insurance.</li>
            <li><strong>Rolling pools, founder backstops, airdrop credit sales.</strong> Parked.</li>
            <li><strong>Duration bonus.</strong> Not agreed; a single fixed term with pro-rata allocation is used.</li>
          </ul>
        </section>
      </div>
      <section className="card stack">
        <h2>Before any real money: launch dependencies</h2>
        <ol className="bullets small">{LAUNCH.map((x) => <li key={x}>{x}</li>)}</ol>
        <p className="small muted">None of these are solved by incorporating offshore, calling the product software, framing rewards as a percentage of an airdrop, or having customers accept risk.</p>
      </section>
    </div>
  );
}
