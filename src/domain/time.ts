export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function toMs(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Invalid timestamp: ${iso}`);
  return t;
}

export function fromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function addMs(iso: string, ms: number): string {
  return fromMs(toMs(iso) + ms);
}

export function addHours(iso: string, hours: number): string {
  return addMs(iso, hours * HOUR_MS);
}

export function addDays(iso: string, days: number): string {
  return addMs(iso, days * DAY_MS);
}

export function diffMs(laterIso: string, earlierIso: string): number {
  return toMs(laterIso) - toMs(earlierIso);
}

export function isBefore(a: string, b: string): boolean {
  return toMs(a) < toMs(b);
}

export function minIso(a: string, b: string): string {
  return toMs(a) <= toMs(b) ? a : b;
}

export function maxIso(a: string, b: string): string {
  return toMs(a) >= toMs(b) ? a : b;
}

/** Overlap in ms between [aFrom, aTo] and [bFrom, bTo]. */
export function overlapMs(aFrom: string, aTo: string, bFrom: string, bTo: string): number {
  const s = Math.max(toMs(aFrom), toMs(bFrom));
  const e = Math.min(toMs(aTo), toMs(bTo));
  return Math.max(0, e - s);
}

export function isValidIso(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
}

/** One canonical spelling per instant, so equal times compare equal as strings. */
export function normalizeIso(iso: string): string {
  return fromMs(toMs(iso));
}
