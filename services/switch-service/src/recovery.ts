import type { Logger } from '@kosh/service-kit';
import type { SagaEngine } from './saga.ts';
import type { SwitchStore } from './store.ts';

export class Recovery {
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly store: SwitchStore,
    private readonly engine: SagaEngine,
    private readonly opts: { batch: number; maxConcurrent: number },
    private readonly log: Logger,
  ) {}

  tick(): number {
    let launched = 0;
    for (const id of this.store.runnable(this.opts.batch)) {
      if (this.running.size >= this.opts.maxConcurrent) break;
      if (this.engine.isDriving(id)) continue;
      const p = this.engine
        .drive(id)
        .catch((err: unknown) => this.log.error('recovery drive failed', { txnId: id, err: err as Error }))
        .finally(() => this.running.delete(p));
      this.running.add(p);
      launched++;
    }
    return launched;
  }

  async drain(maxRounds = 100): Promise<number> {
    let driven = 0;
    for (let round = 0; round < maxRounds; round++) {
      const ids = this.store.runnable(this.opts.batch).filter((id) => !this.engine.isDriving(id));
      if (ids.length === 0) break;
      for (const id of ids) {
        await this.engine.drive(id);
        driven++;
      }
    }
    return driven;
  }

  async idle(): Promise<void> {
    await Promise.all(this.running);
  }
}
