import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/domain/errors';
import { apportion, formatAmount, mulDivFloor, parseAmount, percentString, usdc } from '../src/domain/money';
import { decode, encode } from '../src/domain/serialize';

describe('parseAmount', () => {
  it('parses exact decimal strings into base units', () => {
    expect(parseAmount('600', 'USDC')).toBe(600_000_000n);
    expect(parseAmount('0.000001', 'USDC')).toBe(1n);
    expect(parseAmount('250.5', 'USDC')).toBe(250_500_000n);
    expect(parseAmount('1.000000000000000001', 'FLOP')).toBe(1_000_000_000_000_000_001n);
  });
  it.each(['', ' ', '-5', '+5', '1e3', '1,000', '12.', '.5', 'abc', '0x10', 'NaN', 'Infinity', '1.0000001'])('rejects %j', (bad) => {
    expect(() => parseAmount(bad, 'USDC')).toThrow(DomainError);
  });
  it('never uses floating point (0.1 + 0.2 style inputs stay exact)', () => {
    expect(parseAmount('0.1', 'USDC') + parseAmount('0.2', 'USDC')).toBe(parseAmount('0.3', 'USDC'));
  });
});

describe('formatAmount', () => {
  it('truncates rather than rounds up', () => {
    expect(formatAmount(1_999_999n, 'USDC', { maxFraction: 2 })).toBe('1.99 USDC');
    expect(formatAmount(1_999_999n, 'USDC')).toBe('1.999999 USDC');
    expect(formatAmount(1_500_000n, 'USDC')).toBe('1.50 USDC');
    expect(formatAmount(usdc('2400'), 'USDC')).toBe('2,400.00 USDC');
    expect(formatAmount(10n ** 18n * 1234n + 5n * 10n ** 17n, 'FLOP')).toBe('1,234.5 FLOP');
  });
});

describe('apportion (largest remainder)', () => {
  it('sums exactly and assigns residual units deterministically', () => {
    const parts = apportion(100n, [
      { key: 'a', weight: 1n, tiebreak: '1' },
      { key: 'b', weight: 1n, tiebreak: '2' },
      { key: 'c', weight: 1n, tiebreak: '3' },
    ]);
    expect([...parts.values()].reduce((s, v) => s + v, 0n)).toBe(100n);
    expect(parts.get('a')).toBe(34n);
    expect(parts.get('b')).toBe(33n);
    expect(parts.get('c')).toBe(33n);
  });
  it('gives residual to the largest remainders first', () => {
    const parts = apportion(10n, [
      { key: 'a', weight: 2n, tiebreak: '1' },
      { key: 'b', weight: 7n, tiebreak: '2' },
    ]);
    // 10*2/9 = 2.22, 10*7/9 = 7.77 -> b gets the residual unit
    expect(parts.get('a')).toBe(2n);
    expect(parts.get('b')).toBe(8n);
  });
  it('is stable across many random splits', () => {
    for (let i = 0; i < 200; i++) {
      const total = BigInt(Math.floor(Math.random() * 1e9));
      const items = Array.from({ length: 1 + (i % 7) }, (_, j) => ({ key: `k${j}`, weight: BigInt(1 + Math.floor(Math.random() * 1e6)), tiebreak: `${j}` }));
      const parts = apportion(total, items);
      expect([...parts.values()].reduce((s, v) => s + v, 0n)).toBe(total);
      for (const it of items) {
        const exactFloor = (total * it.weight) / items.reduce((s, x) => s + x.weight, 0n);
        const got = parts.get(it.key)!;
        expect(got === exactFloor || got === exactFloor + 1n).toBe(true);
      }
    }
  });
});

describe('helpers', () => {
  it('percentString and mulDivFloor are exact', () => {
    expect(percentString(600n, 3000n, 4)).toBe('20.0000');
    expect(percentString(1n, 3n, 4)).toBe('33.3333');
    expect(mulDivFloor(10n, 1n, 3n)).toBe(3n);
  });
  it('bigint JSON round trip', () => {
    const v = { a: 10n ** 30n, b: [1n, -2n], c: 'x', d: { $n: 'not-a-number' } };
    expect(decode(encode(v))).toEqual(v);
  });
});
