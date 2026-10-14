import { formatAmount, toDecimalString } from '../domain/money';

export const usd = (units: bigint, opts: { symbol?: boolean } = {}) => formatAmount(units, 'USDC', { symbol: opts.symbol });
export const flp = (units: bigint, opts: { symbol?: boolean; max?: number } = {}) =>
  formatAmount(units, 'FLOP', { symbol: opts.symbol, maxFraction: opts.max ?? 4 });
export const usdInput = (units: bigint) => toDecimalString(units, 'USDC');
export const flopInput = (units: bigint) => toDecimalString(units, 'FLOP');

const dFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const dtFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function date(iso?: string) {
  return iso ? dFmt.format(new Date(iso)) : '—';
}

export function dateTime(iso?: string) {
  return iso ? `${dtFmt.format(new Date(iso))} UTC` : '—';
}

export function duration(ms: number) {
  if (ms <= 0) return '0 h';
  const h = Math.round(ms / 3_600_000);
  const d = Math.floor(h / 24);
  const r = h % 24;
  if (d === 0) return `${Math.max(h, ms > 0 ? 0 : 0)} h`;
  return r ? `${d} d ${r} h` : `${d} d`;
}

export function until(fromIso: string, toIso?: string) {
  if (!toIso) return '—';
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (ms <= 0) return 'passed';
  return `in ${duration(ms)}`;
}

export function pct(s?: string, digits = 2) {
  if (s === undefined) return '—';
  const [w, f = ''] = s.split('.');
  return `${w}${digits ? '.' + (f + '0000').slice(0, digits) : ''}%`;
}

export const KIND_LABEL: Record<string, string> = {
  block_reward: 'Block reward',
  session_payment: 'Session payment',
  airdrop: 'Airdrop',
  other: 'Other',
};
