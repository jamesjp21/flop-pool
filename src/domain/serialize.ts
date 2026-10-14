// JSON encoding that preserves bigint exactly: 123n <-> {"$n":"123"}.

export function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $n: v.toString() } : v));
}

export function decode<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === '$n' && typeof v.$n === 'string' && /^-?\d+$/.test(v.$n)) return BigInt(v.$n);
    }
    return v;
  }) as T;
}

/** Stable JSON with sorted keys, used to compare idempotent requests. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'bigint') return { $n: v.toString() };
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}
