import { describe, expect, it } from 'vitest';
import { add, assertPositive, formatINR, MoneyError, negate, parseRupees, rupees, sub, sum, toRupeeString } from '../src/index.ts';

describe('money', () => {
  it('parses rupee strings into paise', () => {
    expect(parseRupees('500')).toBe(50000);
    expect(parseRupees('500.5')).toBe(50050);
    expect(parseRupees('500.05')).toBe(50005);
    expect(parseRupees('1,00,000.99')).toBe(10000099);
    expect(parseRupees('-12.30')).toBe(-1230);
  });

  it('refuses to round sub-paise amounts', () => {
    expect(() => parseRupees('1.005')).toThrow(MoneyError);
    expect(() => parseRupees('abc')).toThrow(/cannot parse/);
    expect(() => parseRupees('')).toThrow(MoneyError);
  });

  it('formats with Indian digit grouping', () => {
    expect(formatINR(0)).toBe('₹0.00');
    expect(formatINR(99)).toBe('₹0.99');
    expect(formatINR(12345678901)).toBe('₹12,34,56,789.01');
    expect(formatINR(-50000)).toBe('-₹500.00');
    expect(toRupeeString(-5)).toBe('-0.05');
  });

  it('performs checked arithmetic', () => {
    expect(add(100, 250)).toBe(350);
    expect(sub(100, 250)).toBe(-150);
    expect(negate(42)).toBe(-42);
    expect(sum([1, 2, 3, -6])).toBe(0);
    expect(rupees(500)).toBe(50000);
  });

  it('detects overflow instead of losing precision', () => {
    expect(() => add(Number.MAX_SAFE_INTEGER, 1)).toThrow(/safe integer/);
    expect(() => sub(-Number.MAX_SAFE_INTEGER, 1)).toThrow(MoneyError);
  });

  it('rejects non-integer and non-positive amounts', () => {
    expect(() => add(1.5, 1)).toThrow(MoneyError);
    expect(() => assertPositive(0)).toThrow(/greater than zero/);
    expect(() => assertPositive(-1)).toThrow(MoneyError);
    expect(() => rupees(1.5)).toThrow(MoneyError);
    expect(assertPositive(1)).toBe(1);
  });
});
