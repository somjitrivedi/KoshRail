import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrincipalSchema, type Principal } from '@kosh/contracts';
import { type Logger, unauthorized } from '@kosh/service-kit';

export const ISSUER = 'kosh-identity';
export const AUDIENCE = 'kosh';

export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private lastFetch = 0;

  constructor(
    private readonly jwksUrl: string,
    private readonly log: Logger,
    private readonly minRefetchMs = 5000,
  ) {}

  get loaded(): boolean {
    return this.keys.size > 0;
  }

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.lastFetch < this.minRefetchMs) return;
    this.lastFetch = Date.now();
    try {
      const res = await fetch(this.jwksUrl, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`jwks responded ${res.status}`);
      const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
      const next = new Map<string, KeyObject>();
      for (const k of body.keys) next.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
      this.keys = next;
    } catch (err) {
      this.log.warn('jwks refresh failed', { err: err as Error });
    }
  }

  async verify(token: string): Promise<Principal> {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header.kid;
    if (!kid) throw unauthorized('TOKEN_INVALID', 'token is malformed');
    if (!this.keys.has(kid)) await this.refresh();
    const key = this.keys.get(kid);
    if (!key) throw unauthorized('TOKEN_INVALID', 'token signed by unknown key');
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, key, { algorithms: ['RS256'], issuer: ISSUER, audience: AUDIENCE }) as jwt.JwtPayload;
    } catch (err) {
      if ((err as Error).name === 'TokenExpiredError') throw unauthorized('TOKEN_EXPIRED', 'access token has expired');
      throw unauthorized('TOKEN_INVALID', 'token is invalid');
    }
    const parsed = PrincipalSchema.safeParse(payload);
    if (!parsed.success) throw unauthorized('TOKEN_INVALID', 'token claims are invalid');
    return parsed.data;
  }
}
