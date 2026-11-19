import express from 'express';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@kosh/test-kit';
import { httpBankPort } from '../src/banks.ts';
import { classifyError } from '../src/classify.ts';

let url = '';
let close: () => Promise<void>;
let deadUrl = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/banks/OK/hold', (req, res) => {
    res.json({ status: 'HELD', holdId: 'hold_1', ...req.body });
  });
  app.post('/banks/DROP/hold', (req) => {
    req.socket.destroy();
  });
  app.post('/banks/SLOW/hold', (_req, res) => {
    setTimeout(() => res.json({ status: 'HELD' }), 1500);
  });
  app.post('/banks/BUSY/hold', (_req, res) => {
    res.status(503).json({ error: { code: 'ADAPTER_FAULT_INJECTED', message: 'injected' } });
  });
  app.post('/banks/POOR/hold', (_req, res) => {
    res.status(422).json({ error: { code: 'INSUFFICIENT_FUNDS', message: 'no money' } });
  });
  app.get('/banks/OK/status/:txnId', (req, res) => {
    res.json({ txnId: req.params.txnId, bankCode: 'OK', steps: [{ step: 'hold', status: 'DONE', httpStatus: 200, response: {} }] });
  });
  const s = await serve(app);
  url = s.url;
  close = s.close;
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  deadUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await close();
});

async function failureOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return classifyError(err);
  }
  throw new Error('expected the call to fail');
}

describe('5.3 HTTP bank port: real network failures map to the fixed classification', () => {
  const body = { txnId: 'txn_abcdef', accountId: 'acc', amount: 100, ttlSeconds: 60 };

  it('returns the adapter response on 200 and reads status', async () => {
    const port = httpBankPort(url, 't');
    expect(await port.call('OK', 'hold', body, 1000)).toMatchObject({ status: 'HELD', holdId: 'hold_1', amount: 100 });
    expect((await port.status('OK', 'txn_abcdef', 1000)).steps[0]).toMatchObject({ step: 'hold', status: 'DONE' });
  });

  it('a socket closed mid-request is UNKNOWN', async () => {
    expect((await failureOf(httpBankPort(url, 't').call('DROP', 'hold', body, 1000))).kind).toBe('UNKNOWN');
  });

  it('a client timeout is UNKNOWN', async () => {
    const f = await failureOf(httpBankPort(url, 't').call('SLOW', 'hold', body, 200));
    expect(f).toMatchObject({ kind: 'UNKNOWN', code: 'UPSTREAM_TIMEOUT' });
  });

  it('connection refused is TRANSIENT because nothing reached the bank', async () => {
    const f = await failureOf(httpBankPort(deadUrl, 't').call('OK', 'hold', body, 1000));
    expect(f).toMatchObject({ kind: 'TRANSIENT', code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('503 is TRANSIENT and 422 is BUSINESS', async () => {
    expect((await failureOf(httpBankPort(url, 't').call('BUSY', 'hold', body, 1000))).kind).toBe('TRANSIENT');
    expect(await failureOf(httpBankPort(url, 't').call('POOR', 'hold', body, 1000))).toMatchObject({ kind: 'BUSINESS', code: 'INSUFFICIENT_FUNDS' });
  });
});
