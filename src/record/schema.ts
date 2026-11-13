/** Node alone owns these numbered, forward-only record.db migrations. */
export const RECORD_SCHEMA_VERSION = 3;
export interface Migration { version: number; sql: string; }
export const recordMigrations: readonly Migration[] = [{ version: 1, sql: `
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, root_path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('git','folder')),
 shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0,1)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkouts (
 project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'on' CHECK(state IN ('on','off','off until')), off_until TEXT,
 provisional TEXT CHECK(provisional IN ('unborn','shallow')),
 PRIMARY KEY(project_id,path), CHECK((state='off until' AND off_until IS NOT NULL) OR (state!='off until' AND off_until IS NULL))
);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), kind TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','paused','waiting','done','done with gaps','failed','cancelled')),
 reason TEXT, progress TEXT, checkpoint TEXT, tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used>=0),
 tokens_estimate INTEGER CHECK(tokens_estimate>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(state NOT IN ('waiting','failed') OR (reason IS NOT NULL AND length(trim(reason))>0))
);
CREATE INDEX IF NOT EXISTS jobs_project_state ON jobs(project_id,state,created_at);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,updated_at);
CREATE TABLE IF NOT EXISTS job_results (
 job_id TEXT NOT NULL REFERENCES jobs(id), batch INTEGER NOT NULL CHECK(batch>=0), summary TEXT NOT NULL,
 PRIMARY KEY(job_id,batch)
);
CREATE TABLE IF NOT EXISTS model_calls (
 id INTEGER PRIMARY KEY, ts TEXT NOT NULL, project_id TEXT REFERENCES projects(id), purpose TEXT NOT NULL,
 agent TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL CHECK(input>=0),
 cache_write INTEGER NOT NULL CHECK(cache_write>=0), cache_read INTEGER NOT NULL CHECK(cache_read>=0),
 output INTEGER NOT NULL CHECK(output>=0), estimated INTEGER NOT NULL CHECK(estimated IN (0,1))
);
CREATE INDEX IF NOT EXISTS model_calls_ts ON model_calls(ts);
CREATE INDEX IF NOT EXISTS model_calls_project_ts ON model_calls(project_id,ts);
CREATE TABLE IF NOT EXISTS own_usage (
 day TEXT NOT NULL, agent TEXT NOT NULL, input INTEGER NOT NULL CHECK(input>=0),
 cache_write INTEGER NOT NULL CHECK(cache_write>=0), cache_read INTEGER NOT NULL CHECK(cache_read>=0),
 output INTEGER NOT NULL CHECK(output>=0), estimated INTEGER NOT NULL CHECK(estimated IN (0,1)), PRIMARY KEY(day,agent)
);
CREATE TABLE IF NOT EXISTS installs (
 id INTEGER PRIMARY KEY, agent TEXT NOT NULL, path TEXT NOT NULL, key TEXT NOT NULL,
 old_value TEXT, new_value TEXT, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS installs_path_key ON installs(path,key,ts);
CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notices_created ON notices(created_at);
CREATE TABLE IF NOT EXISTS review (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), entry_id TEXT NOT NULL,
 reason TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','accepted','dismissed')), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_project_state ON review(project_id,state,created_at);
CREATE TABLE IF NOT EXISTS judgements (
 project_id TEXT NOT NULL REFERENCES projects(id), entry_id TEXT NOT NULL, inputs_hash TEXT NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('still-true','rewritten','cannot-tell')), at TEXT NOT NULL,
 PRIMARY KEY(project_id,entry_id,inputs_hash)
);
CREATE TABLE IF NOT EXISTS counters_node (
 day TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL CHECK(value>=0), PRIMARY KEY(day,name)
);
CREATE TABLE IF NOT EXISTS settings (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,key));
` }, { version: 2, sql: `
CREATE TABLE usage_files (
 path TEXT PRIMARY KEY, agent TEXT NOT NULL CHECK(agent IN ('claude','codex')),
 root TEXT NOT NULL,
 identity TEXT NOT NULL DEFAULT '', offset INTEGER NOT NULL DEFAULT 0 CHECK(offset>=0),
 size INTEGER NOT NULL DEFAULT 0 CHECK(size>=0),
 anchor TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '{}',
 mtime TEXT NOT NULL DEFAULT '',
 usage_lines INTEGER NOT NULL DEFAULT 0 CHECK(usage_lines>=0),
 skipped_lines INTEGER NOT NULL DEFAULT 0 CHECK(skipped_lines>=0),
 problem_lines INTEGER NOT NULL DEFAULT 0 CHECK(problem_lines>=0),
 failed INTEGER NOT NULL DEFAULT 0 CHECK(failed IN (0,1))
);
CREATE INDEX usage_files_root_path ON usage_files(root,path);
CREATE TABLE usage_events (
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex')), event_id TEXT NOT NULL, day TEXT NOT NULL,
 input INTEGER NOT NULL CHECK(input>=0), cache_write INTEGER NOT NULL CHECK(cache_write>=0),
 cache_read INTEGER NOT NULL CHECK(cache_read>=0), output INTEGER NOT NULL CHECK(output>=0),
 PRIMARY KEY(agent,event_id)
);
CREATE TABLE usage_windows (
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex')), window TEXT NOT NULL, observed_at TEXT NOT NULL,
 used_percent REAL CHECK(used_percent>=0 AND used_percent<=100), resets_at TEXT,
 status TEXT CHECK(status IN ('allowed','allowed_warning','rejected')),
 PRIMARY KEY(agent,window)
);
ALTER TABLE model_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'headless' CHECK(kind IN ('headless','interactive'));
ALTER TABLE model_calls ADD COLUMN session_id TEXT;
CREATE TABLE usage_snapshots (
 session_id TEXT NOT NULL, day TEXT NOT NULL,
 input INTEGER NOT NULL CHECK(input>=0), cache_read INTEGER NOT NULL CHECK(cache_read>=0),
 output INTEGER NOT NULL CHECK(output>=0), PRIMARY KEY(session_id,day)
);
` }, { version: 3, sql: `
ALTER TABLE jobs ADD COLUMN params TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN batch INTEGER NOT NULL DEFAULT 0 CHECK(batch>=0);
ALTER TABLE jobs ADD COLUMN results INTEGER NOT NULL DEFAULT 0 CHECK(results>=0);
ALTER TABLE jobs ADD COLUMN failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0);
ALTER TABLE jobs ADD COLUMN request TEXT CHECK(request IN ('pause','cancel'));
ALTER TABLE jobs ADD COLUMN owner TEXT;
ALTER TABLE jobs ADD COLUMN finished_at TEXT;
CREATE INDEX jobs_running_owner ON jobs(state,owner);
CREATE TABLE background (
 id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, pid INTEGER, version TEXT, started_at TEXT, heartbeat_at TEXT,
 request TEXT CHECK(request IN ('exit')), hub_until TEXT, spawned_at TEXT
);
INSERT INTO background(id) VALUES(1);
` }];
