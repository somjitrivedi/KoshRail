CREATE TABLE users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at TEXT NOT NULL
);

CREATE TABLE otp_challenges (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('REGISTER', 'LOGIN')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX otp_phone_created ON otp_challenges(phone, created_at);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  bound_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (user_id, device_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('customer', 'staff')),
  subject_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  replaced_by TEXT
);
CREATE INDEX sessions_family ON sessions(family_id);

CREATE TABLE mpins (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'BANK_OPS', 'SWITCH_OPS', 'FRAUD_ANALYST')),
  bank_code TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TEXT NOT NULL
);

CREATE TABLE signing_keys (
  kid TEXT PRIMARY KEY,
  private_pem TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
