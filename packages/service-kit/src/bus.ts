import type { DeliveredEvent, EventEnvelope } from '@kosh/contracts';
import { ServiceClient } from './client.ts';

export interface BusPublisher {
  publish(events: EventEnvelope[]): Promise<{ accepted: number; duplicates: number }>;
}

export interface BusSubscriber {
  fetch(group: string, topic: string, max: number, waitMs?: number): Promise<DeliveredEvent[]>;
  commit(group: string, topic: string, offset: number): Promise<void>;
}

export type Bus = BusPublisher & BusSubscriber;

export class HttpBus implements Bus {
  private readonly client: ServiceClient;

  constructor(baseUrl: string, token: string, caller: string) {
    this.client = new ServiceClient(baseUrl, { token, caller, timeoutMs: 10000 });
  }

  async publish(events: EventEnvelope[]) {
    return this.client.post<{ accepted: number; duplicates: number }>('/publish', { events });
  }

  async fetch(group: string, topic: string, max: number, waitMs = 0) {
    const res = await this.client.get<{ events: DeliveredEvent[] }>(`/topics/${encodeURIComponent(topic)}/events`, {
      query: { group, max: String(max), waitMs: String(waitMs) },
      timeoutMs: waitMs + 10000,
    });
    return res.events;
  }

  async commit(group: string, topic: string, offset: number) {
    await this.client.post(`/groups/${encodeURIComponent(group)}/commit`, { topic, offset });
  }

  async seek(group: string, topic: string, offset: number) {
    await this.client.post(`/groups/${encodeURIComponent(group)}/seek`, { topic, offset });
  }
}
