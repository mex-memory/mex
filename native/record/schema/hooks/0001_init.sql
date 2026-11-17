CREATE TABLE IF NOT EXISTS sessions (
 session_id TEXT PRIMARY KEY, agent TEXT NOT NULL, project_id TEXT NOT NULL, checkout TEXT NOT NULL,
 started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1))
);
CREATE INDEX IF NOT EXISTS sessions_project_seen ON sessions(project_id,last_seen_at);
CREATE TABLE IF NOT EXISTS epochs (
 session_id TEXT NOT NULL REFERENCES sessions(session_id), agent_id TEXT NOT NULL DEFAULT '',
 epoch INTEGER NOT NULL CHECK(epoch>=0), started_at TEXT NOT NULL, tokens_sent INTEGER NOT NULL DEFAULT 0 CHECK(tokens_sent>=0),
 PRIMARY KEY(session_id,agent_id,epoch)
);
CREATE TABLE IF NOT EXISTS deliveries (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', epoch INTEGER NOT NULL,
 ts TEXT NOT NULL, moment TEXT NOT NULL, entry_id TEXT NOT NULL,
 form TEXT NOT NULL CHECK(form IN ('full','one-line','pointer','card')), tokens INTEGER NOT NULL CHECK(tokens>=0),
 action TEXT NOT NULL CHECK(action IN ('given','withheld','replaced','held-back')),
 FOREIGN KEY(session_id,agent_id,epoch) REFERENCES epochs(session_id,agent_id,epoch)
);
CREATE INDEX IF NOT EXISTS deliveries_epoch_entry ON deliveries(session_id,agent_id,epoch,entry_id,ts);
CREATE INDEX IF NOT EXISTS deliveries_ts ON deliveries(ts);
CREATE TABLE IF NOT EXISTS followups (
 id INTEGER PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id), ts TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('followed','missed','opened','wrong','edit','command')), detail TEXT
);
CREATE INDEX IF NOT EXISTS followups_delivery ON followups(delivery_id,ts);
CREATE TABLE IF NOT EXISTS verdicts (
 project_id TEXT NOT NULL, checkout TEXT NOT NULL, entry_id TEXT NOT NULL,
 verdict TEXT NOT NULL CHECK(verdict IN ('held','changed','broken','unknown')), inputs_hash TEXT NOT NULL, checked_at TEXT NOT NULL,
 PRIMARY KEY(project_id,checkout,entry_id)
);
CREATE TABLE IF NOT EXISTS ledger (
 session_id TEXT NOT NULL REFERENCES sessions(session_id), agent_id TEXT NOT NULL DEFAULT '', lever TEXT NOT NULL,
 tokens_removed INTEGER NOT NULL DEFAULT 0 CHECK(tokens_removed>=0), turns_carried INTEGER NOT NULL DEFAULT 0 CHECK(turns_carried>=0),
 cost_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cost_tokens>=0), refetches INTEGER NOT NULL DEFAULT 0 CHECK(refetches>=0),
 PRIMARY KEY(session_id,agent_id,lever)
);
CREATE TABLE IF NOT EXISTS journal (
 id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(session_id), ts TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('typed','command')), text TEXT NOT NULL, exit_code INTEGER,
 marks TEXT NOT NULL DEFAULT '' CHECK(marks IN ('','pasted','scripted','pasted,scripted'))
);
CREATE INDEX IF NOT EXISTS journal_session_id ON journal(session_id,id);
CREATE TABLE IF NOT EXISTS outputs (
 n INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(session_id), path TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes>=0)
);
CREATE INDEX IF NOT EXISTS outputs_session ON outputs(session_id,n);
CREATE TABLE IF NOT EXISTS notices_shown (
 notice_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id), ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters_go (
 day TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL CHECK(value>=0), PRIMARY KEY(day,name)
);
