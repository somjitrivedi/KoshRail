export type Paise = number;

export class MoneyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'MoneyError';
  }
}

export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

export function isPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertPaise(value: unknown, label = 'amount'): Paise {
  if (!isPaise(value)) throw new MoneyError('INVALID_AMOUNT', `${label} must be a safe integer number of paise`);
  return value;
}

export function assertPositive(value: unknown, label = 'amount'): Paise {
  const p = assertPaise(value, label);
  if (p <= 0) throw new MoneyError('INVALID_AMOUNT', `${label} must be greater than zero`);
  return p;
}

function checked(result: number): Paise {
  if (!Number.isSafeInteger(result)) throw new MoneyError('AMOUNT_OVERFLOW', 'amount exceeds safe integer range');
  return result;
}

export function add(a: Paise, b: Paise): Paise {
  return checked(assertPaise(a) + assertPaise(b));
}

export function sub(a: Paise, b: Paise): Paise {
  return checked(assertPaise(a) - assertPaise(b));
}

export function negate(a: Paise): Paise {
  return checked(-assertPaise(a));
}

export function sum(values: readonly Paise[]): Paise {
  let total = 0;
  for (const v of values) total = add(total, v);
  return total;
}

export function multiply(a: Paise, factor: number): Paise {
  if (!Number.isSafeInteger(factor)) throw new MoneyError('INVALID_FACTOR', 'factor must be an integer');
  return checked(assertPaise(a) * factor);
}

const RUPEE_PATTERN = /^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/;

export function parseRupees(input: string): Paise {
  const trimmed = input.trim().replace(/,/g, '');
  const match = RUPEE_PATTERN.exec(trimmed);
  if (!match) throw new MoneyError('INVALID_AMOUNT', `cannot parse "${input}" as rupees with at most two decimals`);
  const [, sign, whole, frac = ''] = match;
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return checked(sign ? -paise : paise);
}

export function toRupeeString(p: Paise): string {
  const v = assertPaise(p);
  const neg = v < 0;
  const abs = Math.abs(v);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

export function formatINR(p: Paise): string {
  const v = assertPaise(p);
  const neg = v < 0;
  const abs = Math.abs(v);
  const whole = String(Math.trunc(abs / 100));
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}₹${groupIndian(whole)}.${frac}`;
}

export function rupees(r: number): Paise {
  if (!Number.isSafeInteger(r)) throw new MoneyError('INVALID_AMOUNT', 'rupees helper accepts whole rupees only');
  return checked(r * 100);
}
