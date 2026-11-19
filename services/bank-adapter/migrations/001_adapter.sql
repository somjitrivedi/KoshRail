CREATE TABLE adapter_requests (
  bank_code TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('hold', 'credit', 'capture', 'release', 'reverse')),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'DONE', 'FAILED')),
  http_status INTEGER,
  response TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bank_code, txn_id, step)
);
CREATE INDEX adapter_requests_status ON adapter_requests(status, updated_at);

CREATE TABLE fault_rules (
  bank_code TEXT NOT NULL,
  op TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('NONE', 'LATENCY', 'ERROR', 'TIMEOUT_AFTER_COMMIT', 'DROP_RESPONSE')),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error_rate INTEGER NOT NULL DEFAULT 0 CHECK (error_rate BETWEEN 0 AND 100),
  remaining INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bank_code, op)
);
