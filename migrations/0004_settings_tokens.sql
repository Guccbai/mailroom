-- Settings the owner changes in the web app. A stored value overrides the
-- Worker variable of the same name; deleting the row falls back to it.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Bearer tokens issued from the web app for MCP clients and scripts. Only a
-- SHA-256 hash of each token is stored.
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
