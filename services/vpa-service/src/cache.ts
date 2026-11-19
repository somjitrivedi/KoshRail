export class TtlLru<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit || hit.expiresAt <= this.now()) {
      if (hit) this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits++;
    return hit.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this.evictions++;
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }
}
