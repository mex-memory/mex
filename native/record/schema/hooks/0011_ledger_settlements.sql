CREATE TABLE ledger_settlements (
 session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
 ended_at TEXT NOT NULL
);
