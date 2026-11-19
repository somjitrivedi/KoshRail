CREATE TABLE ledger_accounts (
  account_id TEXT PRIMARY KEY,
  bank_code TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('SAVINGS', 'CURRENT', 'INTERNAL')),
  gl_code TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'FROZEN', 'DORMANT', 'CLOSED')),
  overdraft_limit INTEGER NOT NULL DEFAULT 0,
  per_txn_limit INTEGER NOT NULL,
  daily_debit_limit INTEGER NOT NULL,
  holder_name TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE balances (
  account_id TEXT PRIMARY KEY REFERENCES ledger_accounts(account_id),
  ledger_balance INTEGER NOT NULL DEFAULT 0,
  held_amount INTEGER NOT NULL DEFAULT 0 CHECK (held_amount >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'HOLD_CAPTURE', 'CREDIT', 'REVERSAL', 'ADJUSTMENT')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'POSTED')),
  reference TEXT NOT NULL,
  description TEXT,
  reverses_entry_id TEXT REFERENCES journal_entries(id),
  reversed_by_entry_id TEXT REFERENCES journal_entries(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  posted_at TEXT
);
CREATE UNIQUE INDEX entries_one_reversal ON journal_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX entries_reference ON journal_entries(reference);

CREATE TABLE postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  account_id TEXT NOT NULL REFERENCES ledger_accounts(account_id),
  amount INTEGER NOT NULL CHECK (amount != 0),
  created_at TEXT NOT NULL
);
CREATE INDEX postings_account ON postings(account_id, id);
CREATE INDEX postings_entry ON postings(entry_id);

CREATE TABLE holds (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES ledger_accounts(account_id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED')),
  reference TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  capture_entry_id TEXT REFERENCES journal_entries(id)
);
CREATE INDEX holds_status_expiry ON holds(status, expires_at);
CREATE INDEX holds_account ON holds(account_id, status);

CREATE TRIGGER entry_must_balance BEFORE UPDATE OF status ON journal_entries
WHEN OLD.status = 'PENDING' AND NEW.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_UNBALANCED') WHERE (SELECT COALESCE(SUM(amount), 0) FROM postings WHERE entry_id = NEW.id) != 0;
  SELECT RAISE(ABORT, 'LEDGER_TOO_FEW_POSTINGS') WHERE (SELECT COUNT(*) FROM postings WHERE entry_id = NEW.id) < 2;
END;

CREATE TRIGGER entry_posted_immutable BEFORE UPDATE ON journal_entries
WHEN OLD.status = 'POSTED' AND (
  NEW.status IS NOT OLD.status OR NEW.kind IS NOT OLD.kind OR NEW.reference IS NOT OLD.reference
  OR NEW.reverses_entry_id IS NOT OLD.reverses_entry_id OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.reversed_by_entry_id IS NOT NULL AND NEW.reversed_by_entry_id IS NOT OLD.reversed_by_entry_id)
)
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_ENTRY_IMMUTABLE');
END;

CREATE TRIGGER entry_no_delete BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_ENTRY_IMMUTABLE');
END;

CREATE TRIGGER posting_no_update BEFORE UPDATE ON postings
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_POSTING_IMMUTABLE');
END;

CREATE TRIGGER posting_no_delete BEFORE DELETE ON postings
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_POSTING_IMMUTABLE');
END;

CREATE TRIGGER posting_only_on_pending BEFORE INSERT ON postings
WHEN (SELECT status FROM journal_entries WHERE id = NEW.entry_id) IS NOT 'PENDING'
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_ENTRY_IMMUTABLE');
END;
