CREATE TABLE banks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ifsc_prefix TEXT NOT NULL UNIQUE,
  vpa_handle TEXT NOT NULL UNIQUE,
  number_prefix TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  bank_code TEXT NOT NULL REFERENCES banks(code),
  user_id TEXT,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  kyc_tier TEXT NOT NULL CHECK (kyc_tier IN ('MIN', 'FULL')),
  created_at TEXT NOT NULL,
  UNIQUE (bank_code, phone)
);
CREATE INDEX customers_user ON customers(user_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  bank_code TEXT NOT NULL REFERENCES banks(code),
  customer_id TEXT REFERENCES customers(id),
  account_number TEXT NOT NULL UNIQUE,
  ifsc TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('SAVINGS', 'CURRENT', 'INTERNAL')),
  gl_code TEXT CHECK (gl_code IN ('CASH', 'SWITCH_SETTLEMENT', 'SUSPENSE', 'FEES', 'CENTRAL_SETTLEMENT')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'FROZEN', 'DORMANT', 'CLOSED')),
  overdraft_limit INTEGER NOT NULL DEFAULT 0 CHECK (overdraft_limit >= 0),
  per_txn_limit INTEGER NOT NULL CHECK (per_txn_limit >= 0),
  daily_debit_limit INTEGER NOT NULL CHECK (daily_debit_limit >= 0),
  holder_name TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK ((type = 'INTERNAL') = (gl_code IS NOT NULL)),
  CHECK ((type = 'INTERNAL') = (customer_id IS NULL))
);
CREATE UNIQUE INDEX accounts_bank_gl ON accounts(bank_code, gl_code) WHERE gl_code IS NOT NULL;
CREATE INDEX accounts_customer ON accounts(customer_id);

CREATE TABLE account_numbers (
  bank_code TEXT PRIMARY KEY REFERENCES banks(code),
  next_value INTEGER NOT NULL
);

CREATE TABLE status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  bank_code TEXT NOT NULL REFERENCES banks(code),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('FREEZE', 'UNFREEZE', 'LIMIT_CHANGE', 'CLOSE')),
  payload TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  maker_id TEXT NOT NULL,
  checker_id TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE UNIQUE INDEX approvals_one_pending ON approval_requests(account_id, kind) WHERE status = 'PENDING';
CREATE INDEX approvals_bank_status ON approval_requests(bank_code, status);
