export interface BucketConfig {
  burst: number;
  ratePerSecond: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly cfg: BucketConfig,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): { allowed: boolean; retryAfterSeconds: number; remaining: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.cfg.burst, updatedAt: t };
    const refill = ((t - b.updatedAt) / 1000) * this.cfg.ratePerSecond;
    b.tokens = Math.min(this.cfg.burst, b.tokens + refill);
    b.updatedAt = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(b.tokens) };
    }
    this.buckets.set(key, b);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / this.cfg.ratePerSecond)), remaining: 0 };
  }

  sweep(maxIdleMs = 600000): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.updatedAt > maxIdleMs) this.buckets.delete(k);
  }
}
