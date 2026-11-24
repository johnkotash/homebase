-- HomeBase hub schema (ARCHITECTURE.md section 7). Directory and workspace tables share one file in the prototype.

-- ---------- directory ----------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, display_name TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT, timezone TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'prototype',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL,
  token_hash TEXT UNIQUE, push_token TEXT, push_provider TEXT, can_approve INTEGER NOT NULL DEFAULT 1, public_key TEXT,
  online INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY, workspace_id TEXT, kind TEXT NOT NULL, created_by TEXT, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS integration_tokens (
  id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, scopes TEXT,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);

-- ---------- workspace ----------
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, op TEXT NOT NULL, data TEXT,
  at INTEGER NOT NULL, mutation_id TEXT, actor_id TEXT
);
CREATE TABLE IF NOT EXISTS mutations (
  id TEXT PRIMARY KEY, actor_id TEXT, name TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT, last_message_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, mode TEXT,
  project_id TEXT, note TEXT, summary TEXT, recap TEXT, recap_at INTEGER, recap_run_id TEXT, last_run_status TEXT, last_agent_at INTEGER, read_at INTEGER,
  model TEXT, effort TEXT, session_reset_at INTEGER, image_route TEXT, cwd TEXT, folders TEXT
);
-- A project is a folder for sessions (threads.project_id). A thread with no project is in Unsorted.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_agent_id TEXT, default_cwd TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, image_route TEXT, folders TEXT
);
-- The bytes of images made in sessions (docs/MULTI-PROVIDER-PLAN.md). Not synced: clients fetch a file by id over HTTP.
-- The file itself is in the artifacts folder next to the database, named by id.
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, connector_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL,
  run_id TEXT, author_device_id TEXT, created_at INTEGER NOT NULL, card TEXT, attachments TEXT
);
-- Pictures the owner attached to a message (2026-11-23). The file is in the attachments folder next to the
-- database, named by id. message_id is set when a message takes the picture; until then it is an upload in waiting.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, width INTEGER, height INTEGER,
  name TEXT, device_id TEXT NOT NULL, message_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT, status TEXT NOT NULL, last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, connector_id TEXT, key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]', workspaces TEXT NOT NULL DEFAULT '[]', permission_profile TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL, updated_at INTEGER NOT NULL, status_note TEXT, modes TEXT, default_mode TEXT, auth TEXT, gmail TEXT, vault TEXT,
  models TEXT, efforts TEXT, config_model TEXT, config_effort TEXT, default_model TEXT, default_effort TEXT, images TEXT,
  folders TEXT, default_cwd TEXT, default_folders TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, thread_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL, session_ref TEXT,
  summary TEXT, error TEXT, cost_usd REAL, num_turns INTEGER, duration_ms INTEGER, last_event_idx INTEGER NOT NULL DEFAULT -1,
  started_by TEXT, cwd TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL, mode TEXT,
  model TEXT, effort TEXT, folders TEXT
);
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL, idx INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (run_id, idx)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL, tool TEXT, title TEXT NOT NULL, summary TEXT,
  input TEXT, questions TEXT, risk TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, decision_message TEXT, answers TEXT,
  decided_by TEXT, requested_at INTEGER NOT NULL, decided_at INTEGER, mode TEXT
);
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT, external_url TEXT, title TEXT NOT NULL, snippet TEXT, body TEXT,
  sender TEXT, client_label TEXT, priority TEXT NOT NULL, status TEXT NOT NULL, triage_reason TEXT, assigned_agent_id TEXT,
  linked_thread_id TEXT, linked_run_id TEXT, sla_policy_id TEXT, sla_due_at INTEGER, sla_warn_at INTEGER,
  sla_state TEXT NOT NULL DEFAULT 'none', responded_at INTEGER, snooze_until INTEGER, received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (source, external_id)
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', rev INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'text', vault_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS note_revisions (
  note_id TEXT NOT NULL, rev INTEGER NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (note_id, rev)
);
-- Vault note metadata only (NOTES-PLAN.md 7.2). Note bodies are never stored here.
CREATE TABLE IF NOT EXISTS vault_files (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, type TEXT, tags TEXT NOT NULL DEFAULT '[]', summary TEXT,
  mtime INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, folder TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, config TEXT, secret_ref TEXT, cursor TEXT,
  last_sync_at INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS sla_policies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, match TEXT NOT NULL DEFAULT '{}', respond_within_minutes INTEGER NOT NULL,
  warn_at_pct REAL NOT NULL, calendar TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, priority TEXT NOT NULL, channel TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, link TEXT,
  collapse_key TEXT, subject_type TEXT, subject_id TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, acked_at INTEGER,
  escalation_step INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, actor_id TEXT, action TEXT NOT NULL, subject_type TEXT, subject_id TEXT, detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(status, priority, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_changes_seq ON changes(seq);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, created_at);
