import { isAppError } from '@kosh/service-kit';

export type OutcomeKind = 'OK' | 'BUSINESS' | 'TRANSIENT' | 'UNKNOWN' | 'MISMATCH';

export interface StepFailure {
  kind: Exclude<OutcomeKind, 'OK'>;
  httpStatus: number | null;
  code: string;
  message: string;
}

const BUSINESS_STATUSES = new Set([400, 404, 409, 422]);
const TRANSIENT_STATUSES = new Set([502, 503]);
const REFUSED_CAUSES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export function classifyError(err: unknown): StepFailure {
  if (!isAppError(err)) {
    return { kind: 'UNKNOWN', httpStatus: null, code: 'SWITCH_CALL_ERROR', message: (err as Error)?.message ?? String(err) };
  }
  const base = { httpStatus: err.status, code: err.code, message: err.message };
  if (err.status === 409 && err.code === 'ADAPTER_REQUEST_MISMATCH') return { kind: 'MISMATCH', ...base };
  if (BUSINESS_STATUSES.has(err.status)) return { kind: 'BUSINESS', ...base };
  if (err.code === 'UPSTREAM_UNAVAILABLE') {
    const cause = (err.details as { cause?: string } | undefined)?.cause ?? 'UNKNOWN';
    return { kind: REFUSED_CAUSES.has(cause) ? 'TRANSIENT' : 'UNKNOWN', ...base };
  }
  if (TRANSIENT_STATUSES.has(err.status) || err.status === 429) return { kind: 'TRANSIENT', ...base };
  if (err.status >= 400 && err.status < 500) return { kind: 'BUSINESS', ...base };
  return { kind: 'UNKNOWN', ...base };
}
