import type { Db } from '@kosh/service-kit';

const IST_OFFSET_MS = 330 * 60000;

export function rrnPrefix(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const startOfYear = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((Date.UTC(year, ist.getUTCMonth(), ist.getUTCDate()) - startOfYear) / 86400000) + 1;
  return `${year % 10}${String(dayOfYear).padStart(3, '0')}${String(ist.getUTCHours()).padStart(2, '0')}`;
}

export const RRN_SEQUENCE_DIGITS = 6;
const MAX_SEQUENCE = 10 ** RRN_SEQUENCE_DIGITS - 1;

export function nextRrn(db: Db, at: Date): string {
  const prefix = rrnPrefix(at);
  const value = db
    .prepare('INSERT INTO rrn_counters (prefix, next_value) VALUES (?, 1) ON CONFLICT(prefix) DO UPDATE SET next_value = next_value + 1 RETURNING next_value')
    .pluck()
    .get(prefix) as number;
  if (value > MAX_SEQUENCE) throw new Error(`RRN sequence exhausted for prefix ${prefix}`);
  return `${prefix}${String(value).padStart(RRN_SEQUENCE_DIGITS, '0')}`;
}

export function isRrn(value: string): boolean {
  return /^\d{12}$/.test(value);
}
