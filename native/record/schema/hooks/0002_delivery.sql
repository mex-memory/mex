ALTER TABLE epochs ADD COLUMN reason TEXT NOT NULL DEFAULT 'startup'
 CHECK(reason IN ('startup','compact','clear','fork','subagent','rewind'));
ALTER TABLE epochs ADD COLUMN budget INTEGER NOT NULL DEFAULT 2000 CHECK(budget>0);
ALTER TABLE epochs ADD COLUMN reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0);
ALTER TABLE epochs ADD COLUMN compact_signals INTEGER NOT NULL DEFAULT 0 CHECK(compact_signals>=0);
ALTER TABLE deliveries ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE deliveries ADD COLUMN block_id TEXT NOT NULL DEFAULT '';
ALTER TABLE deliveries ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE deliveries ADD COLUMN checkout TEXT NOT NULL DEFAULT '';
CREATE TABLE aliases (
 project_id TEXT NOT NULL, checkout TEXT NOT NULL, old_id TEXT NOT NULL, new_id TEXT NOT NULL,
 CHECK(old_id<>new_id), PRIMARY KEY(project_id,checkout,old_id)
);
CREATE INDEX deliveries_presence ON deliveries(session_id,agent_id,epoch,project_id,checkout,entry_id,action);
CREATE INDEX epochs_age ON epochs(started_at,session_id,agent_id,epoch);
CREATE INDEX sessions_seen ON sessions(last_seen_at,session_id);
