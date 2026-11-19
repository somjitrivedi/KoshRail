import type { Request } from 'express';
import { HEADERS } from '@kosh/contracts';
import type { Db } from './db.ts';
import { tx } from './db.ts';
import { AppError, badRequest, isAppError, unprocessable } from './errors.ts';
import { sha256, stableStringify } from './ids.ts';

export interface StoredResponse<T = unknown> {
  status: number;
  body: T;
  replayed: boolean;
}

export function idempotencyKey(req: Request, required = true): string | null {
  const raw = req.header(HEADERS.idempotencyKey);
  if (!raw) {
    if (required) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', `${HEADERS.idempotencyKey} header is required`);
    return null;
  }
  if (raw.length < 8 || raw.length > 128 || !/^[A-Za-z0-9:_\-.]+$/.test(raw)) {
    throw badRequest('IDEMPOTENCY_KEY_INVALID', 'idempotency key must be 8-128 characters of [A-Za-z0-9:_-.]');
  }
  return raw;
}

export function idempotent<T>(
  db: Db,
  scope: string,
  key: string,
  request: unknown,
  fn: () => { status: number; body: T },
): StoredResponse<T> {
  const hash = sha256(stableStringify(request));
  return tx(db, () => {
    const existing = db
      .prepare('SELECT request_hash, status, response FROM _idempotency WHERE scope = ? AND key = ?')
      .get(scope, key) as { request_hash: string; status: number; response: string } | undefined;
    if (existing) {
      if (existing.request_hash !== hash) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'idempotency key was already used with a different request');
      }
      return { status: existing.status, body: JSON.parse(existing.response) as T, replayed: true };
    }
    let result: { status: number; body: T };
    try {
      result = tx(db, fn);
    } catch (err) {
      if (isAppError(err) && err.status < 500 && err.status !== 409) {
        result = { status: err.status, body: (err as AppError).toBody() as T };
      } else {
        throw err;
      }
    }
    db.prepare('INSERT INTO _idempotency (scope, key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      scope,
      key,
      hash,
      result.status,
      JSON.stringify(result.body),
      new Date().toISOString(),
    );
    return { ...result, replayed: false };
  });
}
