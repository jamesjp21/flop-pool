import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from './api/types';
import { dateTime } from './format';
import { About } from './pages/About';
import { Audit } from './pages/Audit';
import { CampaignPage } from './pages/CampaignPage';
import { OperatorConsole } from './pages/Operator';
import { Overview } from './pages/Overview';
import { Portfolio } from './pages/Portfolio';
import { Ctx, Flop, Usd, parseHash, routeHash, useApp, useView, type AppCtx, type Route } from './ui';

function readHash(): Route {
  try {
    return parseHash(window.location.hash);
  } catch {
    return { name: 'overview' };
  }
}

function roleFor(r: Route): 'participant' | 'operator' {
  return r.name === 'operator' || r.name === 'audit' ? 'operator' : 'participant';
}

function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2" y="2" width="5" height="5" rx="1" fill="var(--bg)" />
        <rect x="9" y="2" width="5" height="5" rx="1" fill="var(--bg)" opacity="0.55" />
        <rect x="2" y="9" width="5" height="5" rx="1" fill="var(--bg)" opacity="0.55" />
        <rect x="9" y="9" width="5" height="5" rx="1" fill="var(--flop-bar)" />
      </svg>
    </span>
  );
}

function TopBar() {
  const { route, navigate, role, setRole } = useApp();
  const { data } = useView<any>('home');
  const nav: { label: string; route: Route; match: Route['name'][] }[] =
    role === 'participant'
      ? [
          { label: 'Campaigns', route: { name: 'overview' }, match: ['overview', 'campaign'] },
          { label: 'My positions', route: { name: 'portfolio' }, match: ['portfolio'] },
          { label: 'How it works', route: { name: 'about' }, match: ['about'] },
        ]
      : [
          { label: 'Console', route: { name: 'operator' }, match: ['operator'] },
          { label: 'Audit and ledger', route: { name: 'audit' }, match: ['audit'] },
          { label: 'How it works', route: { name: 'about' }, match: ['about'] },
        ];
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); navigate(role === 'operator' ? { name: 'operator' } : { name: 'overview' }); }}>
          <Mark />
          Flop Pool
        </a>
        <nav className="nav" aria-label="Main">
          {nav.map((n) => (
            <button key={n.label} aria-current={n.match.includes(route.name) ? 'page' : undefined} onClick={() => navigate(n.route)}>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {data ? (
            <div className="clock">
              <span className="faint">Demo clock</span>
              <span className="num">{dateTime(data.clock)}</span>
            </div>
          ) : null}
          {data && role === 'participant' ? (
            <button className="wallet-chip" style={{ cursor: 'pointer' }} onClick={() => navigate({ name: 'portfolio' })} title="Your simulated wallet">
              <Usd units={data.wallet.usdcUnits} />
              <Flop units={data.wallet.flopUnits} max={2} />
            </button>
          ) : null}
          <div className="segmented" role="group" aria-label="View as">
            <button aria-pressed={role === 'participant'} onClick={() => { setRole('participant'); navigate({ name: 'overview' }); }}>Participant</button>
            <button aria-pressed={role === 'operator'} onClick={() => { setRole('operator'); navigate({ name: 'operator' }); }}>Operator</button>
          </div>
        </div>
      </div>
    </header>
  );
}

export function App({ api, storageLabel }: { api: ApiClient; storageLabel: string }) {
  const [route, setRoute] = useState<Route>(readHash);
  const [role, setRole] = useState<'participant' | 'operator'>(() => roleFor(readHash()));
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<{ id: number; text: string; error?: boolean }[]>([]);

  useEffect(() => {
    const onHash = () => {
      const r = readHash();
      setRoute(r);
      if (r.name !== 'about') setRole(roleFor(r));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => api.onExternalChange?.(() => setVersion((v) => v + 1)), [api]);

  const navigate = useCallback((r: Route) => {
    setRoute(r);
    try {
      const h = routeHash(r);
      if (window.location.hash !== h) window.history.pushState(null, '', h);
    } catch {
      /* hash routing unavailable: in-memory routing still works */
    }
    window.scrollTo({ top: 0 });
  }, []);

  const toast = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 7000 : 4500);
  }, []);

  const ctx: AppCtx = useMemo(
    () => ({ api, version, bump: () => setVersion((v) => v + 1), route, navigate, role, setRole, toast, storageLabel }),
    [api, version, route, navigate, role, toast, storageLabel],
  );

  let page: React.ReactNode;
  switch (route.name) {
    case 'campaign':
      page = <CampaignPage id={route.id} />;
      break;
    case 'portfolio':
      page = <Portfolio />;
      break;
    case 'operator':
      page = <OperatorConsole id={route.id} />;
      break;
    case 'audit':
      page = <Audit />;
      break;
    case 'about':
      page = <About />;
      break;
    default:
      page = <Overview />;
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="banner" role="note">
        <strong>Demo with simulated funds.</strong> USDC, FLOP, GPU machines and rewards are all simulated. No real money moves, no GPUs are rented, no FLOP network is connected. · {storageLabel}
      </div>
      <TopBar />
      <main className="page">{page}</main>
      <footer className="page small faint" style={{ paddingBlock: '0 32px' }}>
        Independent prototype; not affiliated with or endorsed by the FLOP project. Protocol details reflect an unverified reading of draft documentation.
      </footer>
      <div className="toast-host" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>{t.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
