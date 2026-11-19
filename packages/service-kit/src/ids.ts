import { createHash, randomBytes, randomInt } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(16);
  return Array.from({ length: 16 }, (_, i) => (bytes[i] ?? 0) % 32);
}

function incrementRandom(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    const d = next[i] ?? 0;
    if (d < 31) {
      next[i] = d + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error('ULID random component overflow');
}

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => ENCODING[d]).join('');
}

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function randomDigits(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
