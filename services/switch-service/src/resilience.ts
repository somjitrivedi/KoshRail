import type { Clock } from '@kosh/service-kit';

export type Random = () => number;

export function backoffMs(attempt: number, baseMs: number, capMs: number, random: Random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private opens = 0;

  constructor(
    private readonly clock: Clock,
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
  ) {}

  tryAcquire(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (this.clock.now().getTime() - this.openedAt < this.cooldownMs) return false;
      this.state = 'HALF_OPEN';
      this.probeInFlight = false;
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    this.state = 'CLOSED';
  }

  onFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures++;
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      if (this.state !== 'OPEN') this.opens++;
      this.state = 'OPEN';
      this.openedAt = this.clock.now().getTime();
    }
  }

  snapshot() {
    const coolingDone = this.clock.now().getTime() - this.openedAt >= this.cooldownMs;
    const state: BreakerState = this.state === 'OPEN' && coolingDone ? 'HALF_OPEN' : this.state;
    return { state, consecutiveFailures: this.consecutiveFailures, opens: this.opens };
  }
}

export class Bulkhead {
  private active = 0;
  private rejected = 0;

  constructor(private readonly limit: number) {}

  tryEnter(): boolean {
    if (this.active >= this.limit) {
      this.rejected++;
      return false;
    }
    this.active++;
    return true;
  }

  leave(): void {
    this.active = Math.max(0, this.active - 1);
  }

  snapshot() {
    return { active: this.active, limit: this.limit, rejected: this.rejected };
  }
}

export interface BankGuard {
  breaker: CircuitBreaker;
  bulkhead: Bulkhead;
}

export class BankGuards {
  private readonly guards = new Map<string, BankGuard>();

  constructor(
    private readonly clock: Clock,
    private readonly opts: { failureThreshold: number; cooldownMs: number; bulkheadLimit: number },
  ) {}

  for(bank: string): BankGuard {
    let g = this.guards.get(bank);
    if (!g) {
      g = {
        breaker: new CircuitBreaker(this.clock, this.opts.failureThreshold, this.opts.cooldownMs),
        bulkhead: new Bulkhead(this.opts.bulkheadLimit),
      };
      this.guards.set(bank, g);
    }
    return g;
  }

  snapshot() {
    return [...this.guards.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([bankCode, g]) => ({ bankCode, breaker: g.breaker.snapshot(), bulkhead: g.bulkhead.snapshot() }));
  }
}

export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
