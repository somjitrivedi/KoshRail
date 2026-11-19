import { describe, expect, it } from 'vitest';
import { call, internal, internalHeaders, uniqueSuffix, url } from './helpers.ts';
import { SERVICES, serviceExists } from '../../scripts/stack.ts';

describe('phase 0 - platform skeleton', () => {
  it('every running service answers /health and /ready', async () => {
    const maxPhase = process.env.KOSH_MAX_PHASE ? Number(process.env.KOSH_MAX_PHASE) : Infinity;
    const running = SERVICES.filter((s) => serviceExists(s) && s.phase <= maxPhase);
    expect(running.length).toBeGreaterThan(0);
    for (const s of running) {
      const health = await call('GET', url(s.urlEnv, '/health'));
      expect(health.status, s.name).toBe(200);
      expect(health.body).toEqual({ status: 'ok', service: s.name });
      expect(health.headers.get('x-request-id')).toBeTruthy();
      const ready = await call('GET', url(s.urlEnv, '/ready'));
      expect(ready.status, s.name).toBe(200);
    }
  });

  it('event bus refuses calls without the internal token', async () => {
    const r = await call('GET', url('KOSH_EVENT_BUS_URL', '/topics'));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INTERNAL_TOKEN_INVALID');
    const wrong = await call('GET', url('KOSH_EVENT_BUS_URL', '/topics'), { headers: { 'x-kosh-internal-token': 'nope' } });
    expect(wrong.status).toBe(401);
  });

  it('round-trips events through the bus with dedupe, offsets and redelivery', async () => {
    const topic = `e2e.${uniqueSuffix()}`;
    const group = `g-${uniqueSuffix()}`;
    const events = Array.from({ length: 3 }, (_, i) => ({
      id: `evt_${uniqueSuffix()}_${i}`,
      topic,
      type: 'Ping',
      key: `k${i}`,
      occurredAt: new Date().toISOString(),
      source: 'e2e',
      payload: { i },
    }));
    const pub = await internal('POST', 'KOSH_EVENT_BUS_URL', '/publish', { events });
    expect(pub.status).toBe(202);
    expect(pub.body).toEqual({ accepted: 3, duplicates: 0 });
    const again = await internal('POST', 'KOSH_EVENT_BUS_URL', '/publish', { events });
    expect(again.body).toEqual({ accepted: 0, duplicates: 3 });

    const fetch1 = await internal('GET', 'KOSH_EVENT_BUS_URL', `/topics/${topic}/events?group=${group}&max=10`);
    expect(fetch1.body.events.map((e: { payload: { i: number } }) => e.payload.i)).toEqual([0, 1, 2]);
    const offsets = fetch1.body.events.map((e: { offset: number }) => e.offset);

    await internal('POST', 'KOSH_EVENT_BUS_URL', `/groups/${group}/commit`, { topic, offset: offsets[1] });
    const fetch2 = await internal('GET', 'KOSH_EVENT_BUS_URL', `/topics/${topic}/events?group=${group}&max=10`);
    expect(fetch2.body.events.map((e: { payload: { i: number } }) => e.payload.i)).toEqual([2]);

    await internal('POST', 'KOSH_EVENT_BUS_URL', `/groups/${group}/seek`, { topic, offset: 0 });
    const replay = await internal('GET', 'KOSH_EVENT_BUS_URL', `/topics/${topic}/events?group=${group}&max=10`);
    expect(replay.body.events).toHaveLength(3);
  });

  it('rejects malformed publish payloads', async () => {
    const r = await call('POST', url('KOSH_EVENT_BUS_URL', '/publish'), { headers: internalHeaders(), body: { events: [{ id: '' }] } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
  });
});
