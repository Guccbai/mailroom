-- New outbound drafts may start a conversation, carry several recipients,
-- and include attachments. Rebuild drafts so message_id and thread_id can be
-- empty until the first send creates the thread.
PRAGMA defer_foreign_keys = true;

-- Copy rows aside, then recreate drafts under its own name so that the
-- foreign keys in draft_events and outbound_attempts find their parents again
-- before the transaction commits.
CREATE TABLE drafts_backup AS
SELECT d.*, m.inbox_id AS source_inbox_id
FROM drafts d
LEFT JOIN messages m ON m.id = d.message_id;

DROP TABLE drafts;

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id),
  thread_id TEXT REFERENCES threads(id),
  inbox_id TEXT REFERENCES inboxes(id),
  kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply', 'new')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'rejected', 'sending', 'sent', 'failed')
  ),
  recipient TEXT NOT NULL,
  to_addresses TEXT NOT NULL DEFAULT '[]',
  cc_addresses TEXT NOT NULL DEFAULT '[]',
  sender TEXT NOT NULL,
  reply_to TEXT,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  validation TEXT NOT NULL,
  source TEXT NOT NULL,
  prompt_id TEXT,
  prompt_hash TEXT,
  model TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  CHECK (kind = 'new' OR (message_id IS NOT NULL AND thread_id IS NOT NULL))
);

INSERT INTO drafts (
  id, message_id, thread_id, inbox_id, kind, status, recipient, to_addresses,
  cc_addresses, sender, reply_to, subject, text_body, html_body,
  attachment_count, validation, source, prompt_id, prompt_hash, model,
  provider_message_id, last_error, created_at, updated_at, sent_at
)
SELECT
  id, message_id, thread_id, source_inbox_id, 'reply', status, recipient,
  json_array(recipient), '[]', sender, reply_to, subject, text_body,
  html_body, 0, validation, source, prompt_id, prompt_hash, model,
  provider_message_id, last_error, created_at, updated_at, sent_at
FROM drafts_backup;

DROP TABLE drafts_backup;

CREATE INDEX drafts_status_date ON drafts(status, created_at DESC);
CREATE INDEX drafts_thread ON drafts(thread_id, created_at DESC);

CREATE TABLE draft_attachments (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX draft_attachments_draft ON draft_attachments(draft_id, created_at);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'webhook')),
  event TEXT NOT NULL,
  message_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('delivered', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX notification_deliveries_date
  ON notification_deliveries(created_at DESC);

CREATE TABLE auth_failures (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_started_at TEXT NOT NULL,
  locked_until TEXT
);
