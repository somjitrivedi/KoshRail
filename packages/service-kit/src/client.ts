import { HEADERS, type Principal } from '@kosh/contracts';
import { AppError } from './errors.ts';
import { encodePrincipal } from './caller.ts';

export interface ClientOptions {
  token: string;
  caller: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  principal?: Principal;
  idempotencyKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class ServiceClient {
  constructor(
    readonly baseUrl: string,
    private readonly opts: ClientOptions,
  ) {}

  async request<T>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(ro.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      [HEADERS.internalToken]: this.opts.token,
      [HEADERS.caller]: this.opts.caller,
      ...(ro.headers ?? {}),
    };
    if (ro.body !== undefined) headers['content-type'] = 'application/json';
    if (ro.principal) headers[HEADERS.principal] = encodePrincipal(ro.principal);
    if (ro.idempotencyKey) headers[HEADERS.idempotencyKey] = ro.idempotencyKey;
    const timeoutMs = ro.timeoutMs ?? this.opts.timeoutMs ?? 5000;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: ro.body === undefined ? undefined : JSON.stringify(ro.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AppError(504, 'UPSTREAM_TIMEOUT', `${method} ${url.pathname} timed out after ${timeoutMs}ms`);
      }
      const cause = (err as { cause?: { code?: unknown } }).cause?.code;
      throw new AppError(503, 'UPSTREAM_UNAVAILABLE', `${method} ${url.pathname} failed: ${(err as Error).message}`, {
        cause: typeof cause === 'string' ? cause : 'UNKNOWN',
      });
    }
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new AppError(res.status, e?.code ?? 'UPSTREAM_ERROR', e?.message ?? `upstream responded ${res.status}`, e?.details);
    }
    return data as T;
  }

  get<T>(path: string, ro?: RequestOptions) {
    return this.request<T>('GET', path, ro);
  }

  post<T>(path: string, body?: unknown, ro?: RequestOptions) {
    return this.request<T>('POST', path, { ...ro, body: body ?? {} });
  }

  put<T>(path: string, body?: unknown, ro?: RequestOptions) {
    return this.request<T>('PUT', path, { ...ro, body: body ?? {} });
  }

  del<T>(path: string, ro?: RequestOptions) {
    return this.request<T>('DELETE', path, ro);
  }
}
