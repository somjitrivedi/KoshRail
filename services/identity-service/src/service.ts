import { BANK_CODES, EVENT_TYPES, TOPICS, type Principal, type Role } from '@kosh/contracts';
import {
  AppError,
  addSeconds,
  badRequest,
  type Clock,
  conflict,
  type Db,
  emit,
  forbidden,
  locked,
  newId,
  notFound,
  randomDigits,
  randomToken,
  sha256,
  tooMany,
  tx,
  unauthorized,
} from '@kosh/service-kit';
import {
  assertDevicePublicKey,
  AUDIENCE,
  hashSecret,
  MPIN_AUDIENCE,
  signJwt,
  type SigningKey,
  verifyDeviceSignature,
  verifyJwt,
  verifySecret,
} from './crypto.ts';

export interface IdentityConfig {
  otpDevEcho: boolean;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  otpMaxPerWindow: number;
  otpWindowSeconds: number;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  mpinTokenTtlSeconds: number;
  mpinMaxAttempts: number;
  mpinLockSeconds: number;
}

export const DEFAULT_CONFIG: IdentityConfig = {
  otpDevEcho: false,
  otpTtlSeconds: 300,
  otpMaxAttempts: 3,
  otpMaxPerWindow: 5,
  otpWindowSeconds: 600,
  accessTtlSeconds: 900,
  refreshTtlSeconds: 30 * 24 * 3600,
  mpinTokenTtlSeconds: 120,
  mpinMaxAttempts: 3,
  mpinLockSeconds: 24 * 3600,
};

export const PHONE_PATTERN = /^[6-9]\d{9}$/;

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

interface UserRow {
  id: string;
  phone: string;
  name: string;
  status: string;
  created_at: string;
}

interface StaffRow {
  id: string;
  username: string;
  name: string;
  password_hash: string;
  password_salt: string;
  role: Role;
  bank_code: string | null;
  status: string;
}

interface SessionRow {
  id: string;
  subject_kind: 'customer' | 'staff';
  subject_id: string;
  family_id: string;
  device_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

type Outcome<T> = { ok: T } | { err: AppError };

function unwrap<T>(o: Outcome<T>): T {
  if ('err' in o) throw o.err;
  return o.ok;
}

export function isWeakMpin(mpin: string): boolean {
  if (/^(\d)\1+$/.test(mpin)) return true;
  const digits = mpin.split('').map(Number);
  const asc = digits.every((d, i) => i === 0 || d === ((digits[i - 1] ?? 0) + 1) % 10);
  const desc = digits.every((d, i) => i === 0 || d === ((digits[i - 1] ?? 0) + 9) % 10);
  return asc || desc;
}

export class IdentityService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly key: SigningKey,
    private readonly cfg: IdentityConfig,
  ) {}

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  private nowSeconds(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }

  jwks() {
    return { keys: [this.key.publicJwk] };
  }

  requestOtp(phone: string, purpose: 'REGISTER' | 'LOGIN'): { challengeId: string; expiresAt: string; devCode?: string } {
    if (!PHONE_PATTERN.test(phone)) throw badRequest('PHONE_INVALID', 'phone must be a 10 digit Indian mobile number');
    return tx(this.db, () => {
      const exists = this.db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone);
      if (purpose === 'REGISTER' && exists) throw conflict('PHONE_REGISTERED', 'phone number is already registered');
      if (purpose === 'LOGIN' && !exists) throw notFound('USER_NOT_FOUND', 'no user is registered with this phone number');
      const windowStart = addSeconds(this.clock.now(), -this.cfg.otpWindowSeconds).toISOString();
      const recent = this.db.prepare('SELECT COUNT(*) FROM otp_challenges WHERE phone = ? AND created_at > ?').pluck().get(phone, windowStart) as number;
      if (recent >= this.cfg.otpMaxPerWindow) throw tooMany('OTP_RATE_LIMITED', 'too many OTP requests, try again later');
      const id = newId('otp');
      const code = randomDigits(6);
      const expiresAt = addSeconds(this.clock.now(), this.cfg.otpTtlSeconds).toISOString();
      this.db
        .prepare('INSERT INTO otp_challenges (id, phone, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, phone, purpose, sha256(`${id}:${code}`), expiresAt, this.nowIso());
      return { challengeId: id, expiresAt, ...(this.cfg.otpDevEcho ? { devCode: code } : {}) };
    });
  }

  private consumeOtp(challengeId: string, code: string, purpose: 'REGISTER' | 'LOGIN'): string {
    return unwrap(
      tx(this.db, (): Outcome<string> => {
        const ch = this.db.prepare('SELECT * FROM otp_challenges WHERE id = ?').get(challengeId) as
          | { id: string; phone: string; purpose: string; code_hash: string; attempts: number; expires_at: string; consumed_at: string | null }
          | undefined;
        if (!ch || ch.purpose !== purpose) return { err: badRequest('OTP_INVALID', 'unknown OTP challenge') };
        if (ch.consumed_at) return { err: badRequest('OTP_ALREADY_USED', 'OTP was already used') };
        if (ch.expires_at <= this.nowIso()) return { err: badRequest('OTP_EXPIRED', 'OTP has expired') };
        if (ch.attempts >= this.cfg.otpMaxAttempts) return { err: tooMany('OTP_ATTEMPTS_EXCEEDED', 'too many wrong OTP attempts') };
        if (sha256(`${ch.id}:${code}`) !== ch.code_hash) {
          this.db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?').run(ch.id);
          return { err: badRequest('OTP_INCORRECT', 'OTP is incorrect', { attemptsRemaining: this.cfg.otpMaxAttempts - ch.attempts - 1 }) };
        }
        this.db.prepare('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?').run(this.nowIso(), ch.id);
        return { ok: ch.phone };
      }),
    );
  }

  private accessClaims(kind: 'customer' | 'staff', subjectId: string, familyId: string, deviceId: string | null): Principal {
    if (kind === 'customer') return { sub: subjectId, kind, roles: [], bankCode: null, deviceId, sid: familyId };
    const staff = this.db.prepare('SELECT role, bank_code FROM staff WHERE id = ?').get(subjectId) as { role: Role; bank_code: string | null };
    return { sub: subjectId, kind, roles: [staff.role], bankCode: staff.bank_code, deviceId: null, sid: familyId };
  }

  private issueSession(kind: 'customer' | 'staff', subjectId: string, deviceId: string | null, familyId = newId('fam')): AuthResult {
    const refreshToken = randomToken(32);
    const sessionId = newId('ses');
    const now = this.clock.now();
    this.db
      .prepare(
        'INSERT INTO sessions (id, subject_kind, subject_id, family_id, refresh_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(sessionId, kind, subjectId, familyId, sha256(refreshToken), deviceId, now.toISOString(), addSeconds(now, this.cfg.refreshTtlSeconds).toISOString());
    const claims = this.accessClaims(kind, subjectId, familyId, deviceId);
    const accessToken = signJwt(this.key, claims, this.cfg.accessTtlSeconds, AUDIENCE, this.nowSeconds());
    return { accessToken, refreshToken, expiresIn: this.cfg.accessTtlSeconds, sessionId };
  }

  private bindDevice(userId: string, deviceId: string, publicKey: string): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, user_id, device_id, public_key, status, bound_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)
         ON CONFLICT(user_id, device_id) DO UPDATE SET public_key = excluded.public_key, status = 'ACTIVE', bound_at = excluded.bound_at, revoked_at = NULL`,
      )
      .run(newId('dvc'), userId, deviceId, publicKey, this.nowIso());
    emit(this.db, { topic: TOPICS.identity, type: EVENT_TYPES.DeviceBound, key: userId, payload: { userId, deviceId } }, this.clock);
  }

  register(input: { challengeId: string; code: string; name: string; deviceId: string; devicePublicKey: string }) {
    assertDevicePublicKey(input.devicePublicKey);
    const phone = this.consumeOtp(input.challengeId, input.code, 'REGISTER');
    return tx(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw conflict('PHONE_REGISTERED', 'phone number is already registered');
      const userId = newId('usr');
      this.db.prepare("INSERT INTO users (id, phone, name, status, created_at) VALUES (?, ?, ?, 'ACTIVE', ?)").run(userId, phone, input.name, this.nowIso());
      emit(this.db, { topic: TOPICS.identity, type: EVENT_TYPES.UserRegistered, key: userId, payload: { userId, name: input.name } }, this.clock);
      this.bindDevice(userId, input.deviceId, input.devicePublicKey);
      const auth = this.issueSession('customer', userId, input.deviceId);
      return { user: { id: userId, phone, name: input.name }, ...auth };
    });
  }

  login(input: { challengeId: string; code: string; deviceId: string; devicePublicKey?: string; deviceSignature?: string }) {
    const phone = this.consumeOtp(input.challengeId, input.code, 'LOGIN');
    return tx(this.db, () => {
      const user = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) as UserRow | undefined;
      if (!user) throw notFound('USER_NOT_FOUND', 'user not found');
      if (user.status !== 'ACTIVE') throw forbidden('USER_SUSPENDED', 'user is suspended');
      const device = this.db.prepare("SELECT public_key FROM devices WHERE user_id = ? AND device_id = ? AND status = 'ACTIVE'").get(user.id, input.deviceId) as
        | { public_key: string }
        | undefined;
      let newDevice = false;
      if (device) {
        if (!input.deviceSignature || !verifyDeviceSignature(device.public_key, input.challengeId, input.deviceSignature)) {
          throw unauthorized('DEVICE_SIGNATURE_INVALID', 'device signature over the challenge id is missing or invalid');
        }
      } else {
        if (!input.devicePublicKey) throw badRequest('DEVICE_KEY_REQUIRED', 'devicePublicKey is required to bind a new device');
        assertDevicePublicKey(input.devicePublicKey);
        this.bindDevice(user.id, input.deviceId, input.devicePublicKey);
        newDevice = true;
      }
      const auth = this.issueSession('customer', user.id, input.deviceId);
      return { user: { id: user.id, phone: user.phone, name: user.name }, newDevice, ...auth };
    });
  }

  refresh(refreshToken: string): AuthResult {
    return unwrap(
      tx(this.db, (): Outcome<AuthResult> => {
        const row = this.db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(sha256(refreshToken)) as SessionRow | undefined;
        if (!row) return { err: unauthorized('REFRESH_INVALID', 'refresh token is not recognised') };
        if (row.revoked_at) {
          if (row.revoke_reason === 'ROTATED') {
            this.revokeFamily(row.family_id, 'REUSE_DETECTED');
            return { err: unauthorized('REFRESH_REUSED', 'refresh token was reused; all sessions in this family were revoked') };
          }
          return { err: unauthorized('REFRESH_REVOKED', 'session has been revoked') };
        }
        if (row.expires_at <= this.nowIso()) return { err: unauthorized('REFRESH_EXPIRED', 'refresh token has expired') };
        if (row.subject_kind === 'customer') {
          const user = this.db.prepare('SELECT status FROM users WHERE id = ?').get(row.subject_id) as { status: string } | undefined;
          if (user?.status !== 'ACTIVE') return { err: forbidden('USER_SUSPENDED', 'user is not active') };
          const dev = this.db.prepare('SELECT status FROM devices WHERE user_id = ? AND device_id = ?').get(row.subject_id, row.device_id) as
            | { status: string }
            | undefined;
          if (dev?.status !== 'ACTIVE') {
            this.revokeFamily(row.family_id, 'DEVICE_REVOKED');
            return { err: unauthorized('DEVICE_REVOKED', 'device binding was revoked') };
          }
        } else {
          const staff = this.db.prepare('SELECT status FROM staff WHERE id = ?').get(row.subject_id) as { status: string } | undefined;
          if (staff?.status !== 'ACTIVE') return { err: forbidden('STAFF_DISABLED', 'staff account is disabled') };
        }
        const next = this.issueSession(row.subject_kind, row.subject_id, row.device_id, row.family_id);
        this.db.prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = 'ROTATED', replaced_by = ? WHERE id = ?").run(this.nowIso(), next.sessionId, row.id);
        return { ok: next };
      }),
    );
  }

  private revokeFamily(familyId: string, reason: string): number {
    return this.db.prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE family_id = ? AND revoked_at IS NULL').run(this.nowIso(), reason, familyId)
      .changes;
  }

  logout(refreshToken: string): { revoked: number } {
    return tx(this.db, () => {
      const row = this.db.prepare('SELECT family_id FROM sessions WHERE refresh_hash = ?').get(sha256(refreshToken)) as { family_id: string } | undefined;
      if (!row) return { revoked: 0 };
      return { revoked: this.revokeFamily(row.family_id, 'LOGOUT') };
    });
  }

  ensureBootstrapAdmin(password: string): void {
    tx(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM staff WHERE username = 'admin'").get()) return;
      const { hash, salt } = hashSecret(password);
      this.db
        .prepare("INSERT INTO staff (id, username, name, password_hash, password_salt, role, bank_code, status, created_at) VALUES (?, 'admin', 'Platform Admin', ?, ?, 'ADMIN', NULL, 'ACTIVE', ?)")
        .run(newId('stf'), hash, salt, this.nowIso());
    });
  }

  staffLogin(username: string, password: string) {
    const staff = this.db.prepare('SELECT * FROM staff WHERE username = ?').get(username) as StaffRow | undefined;
    if (!staff || !verifySecret(password, staff.password_hash, staff.password_salt)) {
      throw unauthorized('CREDENTIALS_INVALID', 'username or password is incorrect');
    }
    if (staff.status !== 'ACTIVE') throw forbidden('STAFF_DISABLED', 'staff account is disabled');
    return tx(this.db, () => ({
      staff: { id: staff.id, username: staff.username, name: staff.name, role: staff.role, bankCode: staff.bank_code },
      ...this.issueSession('staff', staff.id, null),
    }));
  }

  createStaff(input: { username: string; name: string; password: string; role: Role; bankCode: string | null }) {
    if (input.role === 'BANK_OPS' && !input.bankCode) throw badRequest('BANK_CODE_REQUIRED', 'BANK_OPS staff must belong to a bank');
    if (input.role !== 'BANK_OPS' && input.bankCode) throw badRequest('BANK_CODE_NOT_ALLOWED', `${input.role} staff are not bank scoped`);
    if (input.bankCode && !(BANK_CODES as readonly string[]).includes(input.bankCode)) throw badRequest('BANK_UNKNOWN', `unknown bank ${input.bankCode}`);
    const { hash, salt } = hashSecret(input.password);
    return tx(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM staff WHERE username = ?').get(input.username)) throw conflict('USERNAME_TAKEN', 'username already exists');
      const id = newId('stf');
      this.db
        .prepare("INSERT INTO staff (id, username, name, password_hash, password_salt, role, bank_code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)")
        .run(id, input.username, input.name, hash, salt, input.role, input.bankCode, this.nowIso());
      return { id, username: input.username, name: input.name, role: input.role, bankCode: input.bankCode };
    });
  }

  listStaff() {
    return this.db.prepare('SELECT id, username, name, role, bank_code AS bankCode, status, created_at AS createdAt FROM staff ORDER BY created_at').all();
  }

  me(p: Principal) {
    if (p.kind === 'staff') {
      const s = this.db.prepare('SELECT id, username, name, role, bank_code AS bankCode, status FROM staff WHERE id = ?').get(p.sub);
      if (!s) throw notFound('STAFF_NOT_FOUND', 'staff not found');
      return { kind: 'staff', ...s };
    }
    const user = this.getUser(p.sub);
    const mpin = this.db.prepare('SELECT locked_until FROM mpins WHERE user_id = ?').get(p.sub) as { locked_until: string | null } | undefined;
    return {
      kind: 'customer',
      ...user,
      currentDeviceId: p.deviceId,
      mpinSet: Boolean(mpin),
      mpinLockedUntil: mpin?.locked_until && mpin.locked_until > this.nowIso() ? mpin.locked_until : null,
      devices: this.listDevices(p.sub),
    };
  }

  getUser(id: string) {
    const u = this.db.prepare('SELECT id, phone, name, status FROM users WHERE id = ?').get(id) as Omit<UserRow, 'created_at'> | undefined;
    if (!u) throw notFound('USER_NOT_FOUND', 'user not found');
    return u;
  }

  listDevices(userId: string) {
    return this.db
      .prepare('SELECT device_id AS deviceId, status, bound_at AS boundAt, revoked_at AS revokedAt FROM devices WHERE user_id = ? ORDER BY bound_at')
      .all(userId);
  }

  revokeDevice(userId: string, deviceId: string, currentDeviceId: string | null) {
    if (deviceId === currentDeviceId) throw badRequest('CANNOT_REVOKE_CURRENT_DEVICE', 'use logout to end the current device session');
    return tx(this.db, () => {
      const r = this.db.prepare("UPDATE devices SET status = 'REVOKED', revoked_at = ? WHERE user_id = ? AND device_id = ? AND status = 'ACTIVE'").run(
        this.nowIso(),
        userId,
        deviceId,
      );
      if (r.changes === 0) throw notFound('DEVICE_NOT_FOUND', 'no active device with that id');
      this.db
        .prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = 'DEVICE_REVOKED' WHERE subject_id = ? AND device_id = ? AND revoked_at IS NULL")
        .run(this.nowIso(), userId, deviceId);
      return { deviceId, status: 'REVOKED' };
    });
  }

  private mpinRow(userId: string) {
    return this.db.prepare('SELECT * FROM mpins WHERE user_id = ?').get(userId) as
      | { user_id: string; hash: string; salt: string; failed_attempts: number; locked_until: string | null }
      | undefined;
  }

  private checkMpin(userId: string, mpin: string): Outcome<true> {
    const row = this.mpinRow(userId);
    if (!row) return { err: notFound('MPIN_NOT_SET', 'MPIN has not been set') };
    const now = this.nowIso();
    if (row.locked_until && row.locked_until > now) {
      return { err: locked('MPIN_LOCKED', 'MPIN is locked after too many wrong attempts', { lockedUntil: row.locked_until }) };
    }
    if (verifySecret(mpin, row.hash, row.salt)) {
      this.db.prepare('UPDATE mpins SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?').run(userId);
      return { ok: true };
    }
    const attempts = (row.locked_until && row.locked_until <= now ? 0 : row.failed_attempts) + 1;
    if (attempts >= this.cfg.mpinMaxAttempts) {
      const lockedUntil = addSeconds(this.clock.now(), this.cfg.mpinLockSeconds).toISOString();
      this.db.prepare('UPDATE mpins SET failed_attempts = ?, locked_until = ? WHERE user_id = ?').run(attempts, lockedUntil, userId);
      emit(this.db, { topic: TOPICS.identity, type: EVENT_TYPES.MpinLocked, key: userId, payload: { userId, lockedUntil } }, this.clock);
      return { err: locked('MPIN_LOCKED', 'MPIN is locked after too many wrong attempts', { lockedUntil }) };
    }
    this.db.prepare('UPDATE mpins SET failed_attempts = ?, locked_until = NULL WHERE user_id = ?').run(attempts, userId);
    return { err: unauthorized('MPIN_INCORRECT', 'MPIN is incorrect') };
  }

  setMpin(userId: string, mpin: string, currentMpin?: string) {
    if (!/^(\d{4}|\d{6})$/.test(mpin)) throw badRequest('MPIN_FORMAT', 'MPIN must be 4 or 6 digits');
    if (isWeakMpin(mpin)) throw badRequest('MPIN_WEAK', 'MPIN must not be repeated or sequential digits');
    this.getUser(userId);
    const existing = this.mpinRow(userId);
    if (existing) {
      if (!currentMpin) throw badRequest('CURRENT_MPIN_REQUIRED', 'currentMpin is required to change the MPIN');
      unwrap(tx(this.db, () => this.checkMpin(userId, currentMpin)));
    }
    const { hash, salt } = hashSecret(mpin);
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO mpins (user_id, hash, salt, failed_attempts, locked_until, updated_at) VALUES (?, ?, ?, 0, NULL, ?)
           ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, salt = excluded.salt, failed_attempts = 0, locked_until = NULL, updated_at = excluded.updated_at`,
        )
        .run(userId, hash, salt, this.nowIso());
    });
    return { mpinSet: true, changed: Boolean(existing) };
  }

  verifyMpin(userId: string, mpin: string, purpose: string) {
    unwrap(tx(this.db, () => this.checkMpin(userId, mpin)));
    const jti = newId('mpt');
    const mpinToken = signJwt(this.key, { sub: userId, purpose, jti }, this.cfg.mpinTokenTtlSeconds, MPIN_AUDIENCE, this.nowSeconds());
    return { mpinToken, expiresAt: addSeconds(this.clock.now(), this.cfg.mpinTokenTtlSeconds).toISOString() };
  }

  verifyMpinToken(token: string) {
    const claims = verifyJwt(this.key, token, MPIN_AUDIENCE, this.nowSeconds());
    return { userId: String(claims.sub), purpose: String(claims.purpose), jti: String(claims.jti) };
  }
}
