import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, newKey, type ApiClient, type Role } from './api/types';
import { flp, usd } from './format';

// ---------------- Routing ----------------

export type Route =
  | { name: 'overview' }
  | { name: 'campaign'; id: string }
  | { name: 'portfolio' }
  | { name: 'operator'; id?: string }
  | { name: 'audit' }
  | { name: 'about' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case 'campaign':
      return parts[1] ? { name: 'campaign', id: parts[1] } : { name: 'overview' };
    case 'portfolio':
      return { name: 'portfolio' };
    case 'operator':
      return { name: 'operator', id: parts[1] };
    case 'audit':
      return { name: 'audit' };
    case 'about':
      return { name: 'about' };
    default:
      return { name: 'overview' };
  }
}

export function routeHash(r: Route): string {
  switch (r.name) {
    case 'campaign':
      return `#/campaign/${r.id}`;
    case 'operator':
      return r.id ? `#/operator/${r.id}` : '#/operator';
    case 'overview':
      return '#/';
    default:
      return `#/${r.name}`;
  }
}

// ---------------- App context ----------------

interface Toast {
  id: number;
  text: string;
  error?: boolean;
}

export interface AppCtx {
  api: ApiClient;
  version: number;
  bump: () => void;
  route: Route;
  navigate: (r: Route) => void;
  role: 'participant' | 'operator';
  setRole: (r: 'participant' | 'operator') => void;
  toast: (text: string, error?: boolean) => void;
  storageLabel: string;
}

export const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

export function useView<T = any>(name: string, params: Record<string, string | undefined> = {}) {
  const { api, version } = useApp();
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const key = JSON.stringify(params);
  useEffect(() => {
    let live = true;
    api
      .view<T>(name, params)
      .then((d) => {
        if (live) {
          setData(d);
          setError(undefined);
        }
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, name, key, version]);
  return { data, error };
}

/**
 * Run a command. Each logical user action gets one idempotency key, kept until it
 * succeeds, so a double click or a retried request can never apply twice.
 */
export function useCommand() {
  const { api, bump, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string>(newKey());
  const run = useCallback(
    async <T = any,>(role: Role, type: string, input: Record<string, unknown>, success?: string | ((r: T, dup: boolean) => string)): Promise<T | undefined> => {
      setBusy(true);
      const key = keyRef.current;
      try {
        const out = await api.command<T>(role, type, input, key);
        keyRef.current = newKey();
        bump();
        const msg = typeof success === 'function' ? success(out.result, out.duplicate) : success;
        if (msg) toast(out.duplicate ? `${msg} (already processed — nothing applied twice)` : msg);
        return out.result;
      } catch (e) {
        if (e instanceof ApiError) {
          // A rejected request changed nothing; the next attempt is a new request.
          keyRef.current = newKey();
          toast(e.message, true);
          throw e;
        }
        toast(e instanceof Error ? e.message : String(e), true);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [api, bump, toast],
  );
  return { run, busy };
}

// ---------------- Small components ----------------

export function Usd({ units, sim = false }: { units: bigint; sim?: boolean }) {
  return (
    <span className="num">
      {usd(units)}
      {sim ? ' ' : ''}
      {sim ? <span className="sim">sim</span> : null}
    </span>
  );
}

export function Flop({ units, max }: { units: bigint; max?: number }) {
  return (
    <span className="num flop" title={`${units.toString()} base units`}>
      {flp(units, { max })}
    </span>
  );
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'flop' | 'demo';
export function Pill({ tone = 'neutral', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  return <span className={`pill pill-${tone}${plain ? ' plain' : ''}`}>{children}</span>;
}

export const CAMPAIGN_TONE: Record<string, Tone> = {
  funding: 'accent',
  funded: 'warn',
  running: 'ok',
  ended: 'neutral',
  cancelled: 'neutral',
  funding_failed: 'neutral',
};

export const OPS_TONE: Record<string, Tone> = {
  not_started: 'neutral',
  provisioning: 'warn',
  healthy: 'ok',
  recovering: 'warn',
  manual_intervention: 'bad',
  stopped: 'neutral',
};

export function Sim({ children = 'Simulated' }: { children?: ReactNode }) {
  return <span className="sim">{children}</span>;
}

export function Progress({ value, max }: { value: bigint; max: bigint }) {
  const w = max > 0n ? Number((value * 10000n) / max) / 100 : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(w)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.min(100, w)}%` }} />
    </div>
  );
}

export function RewardBar({ claimed, claimable, locked }: { claimed: bigint; claimable: bigint; locked: bigint }) {
  const total = claimed + claimable + locked;
  const w = (v: bigint) => (total > 0n ? Number((v * 10000n) / total) / 100 : 0);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="rewardbar" aria-hidden="true">
        <span className="seg-claimed" style={{ width: `${w(claimed)}%` }} />
        <span className="seg-claimable" style={{ width: `${w(claimable)}%` }} />
        <span className="seg-locked" style={{ width: `${w(locked)}%` }} />
      </div>
      <div className="legend">
        <span><i className="seg-claimed" />Claimed <Flop units={claimed} /></span>
        <span><i className="seg-claimable" />Claimable <Flop units={claimable} /></span>
        <span><i className="seg-locked" />Locked (your share) <Flop units={locked} /></span>
      </div>
    </div>
  );
}

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = 'btn',
  disabled,
  prompt,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<unknown>;
  className?: string;
  disabled?: boolean;
  prompt?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className={className} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm">
      {prompt ? <span className="small muted">{prompt}</span> : null}
      <button
        className={className}
        onClick={async () => {
          setAsking(false);
          try {
            await onConfirm();
          } catch {
            /* toast already shown */
          }
        }}
      >
        {confirmLabel}
      </button>
      <button className="btn btn-sm" onClick={() => setAsking(false)}>
        Keep as is
      </button>
    </span>
  );
}

export function Loading({ error }: { error?: string }) {
  return <div className="loading">{error ? `Could not load: ${error}` : 'Loading…'}</div>;
}

export function Check({ done }: { done: boolean }) {
  return (
    <span className={`check${done ? ' done' : ''}`} aria-label={done ? 'Done' : 'Not done yet'}>
      {done ? (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 5.2 4 7.5 8.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}
