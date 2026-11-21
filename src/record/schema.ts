/** Node alone owns these numbered, forward-only record.db migrations. */
export const RECORD_SCHEMA_VERSION = 6;
/** The hooks.db migrations are owned by Go. */
export const HOOKS_SCHEMA_VERSION = 15;
export const LEDGER_REPORT_SCHEMA_VERSION = 13;
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
` }, { version: 4, sql: `
CREATE TABLE model_batches (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 agent TEXT NOT NULL, requested_model TEXT NOT NULL,
 automatic INTEGER NOT NULL CHECK(automatic IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('queued','running','done','cancelled','interrupted')),
 owner TEXT NOT NULL, pid INTEGER NOT NULL CHECK(pid>0),
 project_id TEXT REFERENCES projects(id), job_id TEXT REFERENCES jobs(id), job_batch INTEGER,
 created_at TEXT NOT NULL, admitted_at TEXT, finished_at TEXT,
 reserved_units INTEGER NOT NULL CHECK(reserved_units>=0),
 charged_units INTEGER NOT NULL DEFAULT 0 CHECK(charged_units>=0),
 estimated INTEGER NOT NULL DEFAULT 1 CHECK(estimated IN (0,1)),
 pricing TEXT NOT NULL CHECK(length(pricing)<=4096),
 wait_reason TEXT CHECK(wait_reason IN ('cap','fallback','usage-window','off','queue','storage','pricing'))
);
CREATE INDEX model_batches_queue ON model_batches(state,id);
CREATE UNIQUE INDEX model_batches_one_running ON model_batches(state) WHERE state='running';
CREATE INDEX model_batches_spend ON model_batches(automatic,admitted_at);
CREATE INDEX model_batches_job ON model_batches(job_id,job_batch,id);
ALTER TABLE model_calls ADD COLUMN batch_id INTEGER REFERENCES model_batches(id);
CREATE INDEX model_calls_batch ON model_calls(batch_id);
` }, { version: 5, sql: `
CREATE TABLE aid_verdicts (
 project_id TEXT NOT NULL, entry_id TEXT NOT NULL CHECK(length(entry_id)<=67),
 kind TEXT NOT NULL CHECK(kind IN ('alias','ask')), text TEXT NOT NULL CHECK(length(text)<=120),
 kept INTEGER NOT NULL CHECK(kept IN (0,1)), reason TEXT NOT NULL CHECK(length(reason)<=256),
 score REAL, margin REAL, top_entry TEXT CHECK(top_entry IS NULL OR length(top_entry)<=67),
 review INTEGER NOT NULL DEFAULT 0 CHECK(review IN (0,1)),
 source TEXT NOT NULL CHECK(source IN ('hand','enrich','setup','import','filter')),
 corpus TEXT NOT NULL CHECK(length(corpus)<=80), decided_at TEXT NOT NULL,
 PRIMARY KEY(project_id,entry_id,kind,text)
);
CREATE INDEX aid_verdicts_review ON aid_verdicts(project_id,review) WHERE review=1;
CREATE TABLE decision_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id TEXT NOT NULL, entry_id TEXT NOT NULL CHECK(length(entry_id)<=67),
 event TEXT NOT NULL CHECK(event IN ('accepted','withdrawn')),
 commit_sha TEXT NOT NULL CHECK(length(commit_sha) IN (40,64)),
 landed_sha TEXT CHECK(landed_sha IS NULL OR length(landed_sha) IN (40,64)),
 matched_by TEXT NOT NULL CHECK(matched_by IN ('sha','patch-id','subject-files','revert','missing')),
 branch TEXT NOT NULL CHECK(length(branch)<=256), actor TEXT NOT NULL CHECK(length(actor)<=256), at TEXT NOT NULL
);
CREATE INDEX decision_events_entry ON decision_events(project_id,entry_id,id);
CREATE TRIGGER decision_events_no_update BEFORE UPDATE ON decision_events BEGIN SELECT RAISE(ABORT,'decision events are append-only'); END;
CREATE TRIGGER decision_events_no_delete BEFORE DELETE ON decision_events BEGIN SELECT RAISE(ABORT,'decision events are append-only'); END;
` }, { version: 6, sql: `
CREATE TABLE build_usage (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 ts TEXT NOT NULL, project_id TEXT NOT NULL CHECK(length(project_id)<=80), checkout TEXT NOT NULL CHECK(length(checkout)<=4096),
 kind TEXT NOT NULL CHECK(kind IN ('build','refresh','verify','warm')),
 files INTEGER NOT NULL DEFAULT 0 CHECK(files>=0),
 wall_ms INTEGER NOT NULL CHECK(wall_ms>=0), cpu_ms INTEGER NOT NULL CHECK(cpu_ms>=0),
 peak_rss_mb INTEGER NOT NULL CHECK(peak_rss_mb>=0), server_rss_mb INTEGER CHECK(server_rss_mb IS NULL OR server_rss_mb>=0),
 result TEXT NOT NULL CHECK(result IN ('ok','unchanged','failed')),
 runs INTEGER NOT NULL DEFAULT 1 CHECK(runs>=1)
);
CREATE INDEX build_usage_project ON build_usage(project_id,kind,ts);
CREATE INDEX build_usage_ts ON build_usage(ts);
CREATE UNIQUE INDEX build_usage_warm_minute ON build_usage(project_id,checkout,ts) WHERE kind='warm';
` }];
