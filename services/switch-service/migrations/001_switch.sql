CREATE TABLE txns (
  id TEXT PRIMARY KEY,
  rrn TEXT NOT NULL UNIQUE,
  payer_user_id TEXT NOT NULL,
  payer_vpa TEXT NOT NULL,
  payer_bank TEXT NOT NULL,
  payer_account TEXT NOT NULL,
  payee_user_id TEXT,
  payee_vpa TEXT NOT NULL,
  payee_bank TEXT NOT NULL,
  payee_account TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  state TEXT NOT NULL CHECK (state IN ('INITIATED', 'RISK_PASSED', 'DEBIT_HELD', 'CREDITED', 'COMPLETED', 'DEBIT_FAILED', 'CREDIT_FAILED', 'REVERSING', 'REVERSED', 'DEEMED', 'MANUAL_REVIEW')),
  hold_ttl_seconds INTEGER NOT NULL,
  hold_id TEXT,
  credit_entry_id TEXT,
  capture_entry_id TEXT,
  reversal_entry_id TEXT,
  hold_released INTEGER NOT NULL DEFAULT 0 CHECK (hold_released IN (0, 1)),
  deemed_step TEXT,
  deemed_polls INTEGER NOT NULL DEFAULT 0,
  park_count INTEGER NOT NULL DEFAULT 0,
  review_from TEXT,
  failure_code TEXT,
  failure_message TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  fence INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX txns_runnable ON txns(next_run_at) WHERE state NOT IN ('COMPLETED', 'DEBIT_FAILED', 'REVERSED', 'MANUAL_REVIEW');
CREATE INDEX txns_payer ON txns(payer_user_id, created_at);
CREATE INDEX txns_payee ON txns(payee_user_id, created_at);
CREATE INDEX txns_state ON txns(state, updated_at);
CREATE INDEX txns_finished ON txns(finished_at);

CREATE TABLE saga_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL REFERENCES txns(id),
  step TEXT NOT NULL CHECK (step IN ('risk', 'hold', 'credit', 'capture', 'release', 'reverse', 'inquiry')),
  bank_code TEXT,
  attempt INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'OK', 'BUSINESS', 'TRANSIENT', 'UNKNOWN', 'MISMATCH')),
  http_status INTEGER,
  code TEXT,
  request TEXT,
  response TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX saga_steps_txn ON saga_steps(txn_id, id);

CREATE TABLE txn_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL REFERENCES txns(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT,
  fence INTEGER NOT NULL,
  owner TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX txn_transitions_txn ON txn_transitions(txn_id, id);

CREATE TABLE used_mpin_tokens (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  used_at TEXT NOT NULL
);

CREATE TABLE rrn_counters (
  prefix TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL
);

CREATE TABLE ops_actions (
  id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL REFERENCES txns(id),
  action TEXT NOT NULL CHECK (action IN ('RETRY', 'REVERSE')),
  staff_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX ops_actions_txn ON ops_actions(txn_id, at);
