CREATE TABLE vpas (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL,
  psp_handle TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TEXT NOT NULL,
  disabled_at TEXT
);
CREATE INDEX vpas_user ON vpas(user_id);

CREATE TABLE vpa_links (
  id TEXT PRIMARY KEY,
  vpa_id TEXT NOT NULL REFERENCES vpas(id),
  account_id TEXT NOT NULL,
  bank_code TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'UNLINKED')),
  linked_at TEXT NOT NULL,
  unlinked_at TEXT
);
CREATE UNIQUE INDEX vpa_links_one_active ON vpa_links(vpa_id, account_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX vpa_links_one_default ON vpa_links(vpa_id) WHERE status = 'ACTIVE' AND is_default = 1;
CREATE INDEX vpa_links_account ON vpa_links(account_id) WHERE status = 'ACTIVE';

CREATE TABLE account_view (
  account_id TEXT PRIMARY KEY,
  bank_code TEXT NOT NULL,
  status TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  user_id TEXT,
  updated_at TEXT NOT NULL
);
