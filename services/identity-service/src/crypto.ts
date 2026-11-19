import { createPublicKey, generateKeyPairSync, randomBytes, scryptSync, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { type Db, newId, unauthorized } from '@kosh/service-kit';

export function hashSecret(secret: string, salt = randomBytes(16).toString('hex')): { hash: string; salt: string } {
  return { hash: scryptSync(secret, salt, 32).toString('hex'), salt };
}

export function verifySecret(secret: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(secret, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function assertDevicePublicKey(pem: string): void {
  try {
    const key = createPublicKey(pem);
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') throw new Error('curve');
  } catch {
    throw unauthorized('DEVICE_KEY_INVALID', 'device public key must be an EC P-256 SPKI PEM');
  }
}

export function verifyDeviceSignature(pem: string, message: string, signatureB64: string): boolean {
  try {
    return verify('sha256', Buffer.from(message), createPublicKey(pem), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export interface SigningKey {
  kid: string;
  privatePem: string;
  publicJwk: JsonWebKey;
}

export function loadOrCreateSigningKey(db: Db): SigningKey {
  const row = db.prepare('SELECT kid, private_pem, public_jwk FROM signing_keys WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get() as
    | { kid: string; private_pem: string; public_jwk: string }
    | undefined;
  if (row) return { kid: row.kid, privatePem: row.private_pem, publicJwk: JSON.parse(row.public_jwk) as JsonWebKey };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = newId('key');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } as JsonWebKey;
  db.prepare('INSERT INTO signing_keys (kid, private_pem, public_jwk, created_at) VALUES (?, ?, ?, ?)').run(
    kid,
    privatePem,
    JSON.stringify(publicJwk),
    new Date().toISOString(),
  );
  return { kid, privatePem, publicJwk };
}

export const ISSUER = 'kosh-identity';
export const AUDIENCE = 'kosh';
export const MPIN_AUDIENCE = 'kosh-mpin';

export function signJwt(key: SigningKey, claims: Record<string, unknown>, ttlSeconds: number, audience: string, nowSeconds: number): string {
  return jwt.sign({ ...claims, iat: nowSeconds, exp: nowSeconds + ttlSeconds }, key.privatePem, {
    algorithm: 'RS256',
    keyid: key.kid,
    issuer: ISSUER,
    audience,
  });
}

export function verifyJwt(key: SigningKey, token: string, audience: string, nowSeconds: number): jwt.JwtPayload {
  try {
    const publicKey = createPublicKey({ key: key.publicJwk, format: 'jwk' });
    return jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: ISSUER, audience, clockTimestamp: nowSeconds }) as jwt.JwtPayload;
  } catch {
    throw unauthorized('TOKEN_INVALID', 'token is invalid or expired');
  }
}
