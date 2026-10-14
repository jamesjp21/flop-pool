// Exact integer arithmetic for money and token amounts. No floating point.
//
// Every amount in the domain is a bigint count of base units:
//   USDC (simulated): 6 decimals  -> 1 USDC = 1_000_000 units
//   FLOP (simulated): 18 decimals -> assumption, see config.ts

import { DomainError } from './errors';

export type Asset = 'USDC' | 'FLOP';

export const DECIMALS: Record<Asset, number> = {
  USDC: 6,
  FLOP: 18, // ASSUMPTION: FLOP base-unit precision not confirmed from official docs.
};

export function unit(asset: Asset): bigint {
  return 10n ** BigInt(DECIMALS[asset]);
}

const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parse a user-entered decimal string into base units, exactly.
 * Rejects empty input, signs, exponents, separators, and excess precision.
 */
export function parseAmount(input: unknown, asset: Asset, field = 'amount'): bigint {
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new DomainError('INVALID_AMOUNT', `Enter the ${field} as a number, for example 100 or 250.50.`);
  }
  const raw = String(input).trim();
  if (raw === '') throw new DomainError('INVALID_AMOUNT', `Enter the ${field}.`);
  const m = AMOUNT_RE.exec(raw);
  if (!m) {
    throw new DomainError(
      'INVALID_AMOUNT',
      `"${raw.slice(0, 40)}" is not a valid ${field}. Use digits and an optional decimal point, for example 100 or 250.50.`,
    );
  }
  const decimals = DECIMALS[asset];
  const whole = m[1];
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    throw new DomainError('INVALID_AMOUNT', `${asset} supports at most ${decimals} decimal places.`);
  }
  if (whole.length > 30) throw new DomainError('INVALID_AMOUNT', `The ${field} is too large.`);
  const units = BigInt(whole) * unit(asset) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return units;
}

/** Parse and require a strictly positive amount. */
export function parsePositiveAmount(input: unknown, asset: Asset, field = 'amount'): bigint {
  const v = parseAmount(input, asset, field);
  if (v <= 0n) throw new DomainError('INVALID_AMOUNT', `The ${field} must be greater than zero.`);
  return v;
}

export interface FormatOptions {
  /** Maximum fraction digits to show (truncates toward zero; never rounds up). */
  maxFraction?: number;
  /** Minimum fraction digits to show. */
  minFraction?: number;
  /** Append the asset symbol. */
  symbol?: boolean;
  grouping?: boolean;
}

/** Format base units as a decimal string. Truncates (never rounds up) so displays never overstate. */
export function formatAmount(units: bigint, asset: Asset, opts: FormatOptions = {}): string {
  const decimals = DECIMALS[asset];
  const maxFraction = opts.maxFraction ?? (asset === 'USDC' ? 2 : 4);
  const minFraction = opts.minFraction ?? (asset === 'USDC' ? 2 : 0);
  const grouping = opts.grouping ?? true;
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = unit(asset);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, Math.min(maxFraction, decimals));
  while (frac.length > minFraction && frac.endsWith('0')) frac = frac.slice(0, -1);
  const wholeStr = grouping ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole.toString();
  const body = frac.length ? `${wholeStr}.${frac}` : wholeStr;
  return `${neg ? '-' : ''}${body}${opts.symbol === false ? '' : ` ${asset}`}`;
}

/** Full-precision decimal string, no grouping, no symbol (for inputs and audit). */
export function toDecimalString(units: bigint, asset: Asset): string {
  return formatAmount(units, asset, { maxFraction: DECIMALS[asset], minFraction: 0, grouping: false, symbol: false });
}

/** floor(a * b / c) for non-negative integers. */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (c <= 0n) throw new Error('mulDivFloor: divisor must be positive');
  if (a < 0n || b < 0n) throw new Error('mulDivFloor: operands must be non-negative');
  return (a * b) / c;
}

/** Exact percentage string of num/den, truncated to `places` decimals. */
export function percentString(num: bigint, den: bigint, places = 2): string {
  if (den <= 0n) return '0';
  const scale = 10n ** BigInt(places);
  const scaled = (num * 100n * scale) / den;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(places, '0');
  return places > 0 ? `${whole}.${frac}` : whole.toString();
}

export interface Weighted<K extends string = string> {
  key: K;
  weight: bigint;
  /** Lower tiebreak wins residual units first when remainders are equal. */
  tiebreak: string;
}

/**
 * Largest-remainder apportionment of `total` units by integer weights.
 * The parts always sum exactly to `total`. Residual units (total minus the sum of
 * floors) go one each to the largest fractional remainders; ties are broken by
 * `tiebreak` ascending, then by key. Deterministic for identical inputs.
 */
export function apportion<K extends string>(total: bigint, items: Weighted<K>[]): Map<K, bigint> {
  const out = new Map<K, bigint>();
  if (total < 0n) throw new Error('apportion: total must be non-negative');
  const sumW = items.reduce((s, i) => s + i.weight, 0n);
  if (items.length === 0) {
    if (total !== 0n) throw new Error('apportion: no recipients for non-zero total');
    return out;
  }
  if (sumW <= 0n) {
    if (total !== 0n) throw new Error('apportion: weights must sum to a positive value');
    for (const i of items) out.set(i.key, 0n);
    return out;
  }
  let allocated = 0n;
  const rema: { key: K; rem: bigint; tiebreak: string }[] = [];
  for (const i of items) {
    if (i.weight < 0n) throw new Error('apportion: negative weight');
    const prod = total * i.weight;
    const share = prod / sumW;
    out.set(i.key, share);
    allocated += share;
    rema.push({ key: i.key, rem: prod % sumW, tiebreak: i.tiebreak });
  }
  let residual = total - allocated;
  rema.sort((a, b) => (a.rem === b.rem ? cmpStr(a.tiebreak, b.tiebreak) || cmpStr(a.key, b.key) : a.rem > b.rem ? -1 : 1));
  for (const r of rema) {
    if (residual === 0n) break;
    // Only weighted recipients may receive residual units.
    const item = items.find((i) => i.key === r.key)!;
    if (item.weight === 0n) continue;
    out.set(r.key, out.get(r.key)! + 1n);
    residual -= 1n;
  }
  if (residual !== 0n) throw new Error('apportion: residual could not be assigned');
  return out;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sum(values: Iterable<bigint>): bigint {
  let s = 0n;
  for (const v of values) s += v;
  return s;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export const usdc = (s: string) => parseAmount(s, 'USDC');
export const flop = (s: string) => parseAmount(s, 'FLOP');
