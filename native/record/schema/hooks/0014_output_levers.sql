CREATE TABLE lever_state (
 agent TEXT NOT NULL, session_id TEXT NOT NULL, subagent TEXT NOT NULL,
 state TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(agent,session_id,subagent)
) WITHOUT ROWID;
CREATE INDEX lever_state_age ON lever_state(updated_at);
CREATE TABLE outline_guard (
 id INTEGER PRIMARY KEY CHECK(id=1), outlines INTEGER NOT NULL DEFAULT 0,
 trips INTEGER NOT NULL DEFAULT 0, off INTEGER NOT NULL DEFAULT 0,
 off_since TEXT NOT NULL DEFAULT '', rearmed_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO outline_guard(id) VALUES(1);
CREATE TABLE compact_nudge_state (
 agent TEXT NOT NULL, session_id TEXT NOT NULL, subagent TEXT NOT NULL,
 state TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(agent,session_id,subagent)
) WITHOUT ROWID;
CREATE INDEX compact_nudge_state_age ON compact_nudge_state(updated_at);
