-- Bound the copy before rebuilding the action constraint and its dependents.
CREATE TEMP TABLE surface_migration_bound (n INTEGER CHECK(n<=100000));
INSERT INTO surface_migration_bound SELECT count(*) FROM (SELECT 1 FROM deliveries LIMIT 100001);
INSERT INTO surface_migration_bound SELECT count(*) FROM (SELECT 1 FROM followups LIMIT 100001);
CREATE TEMP TABLE surface_followups AS SELECT * FROM followups;
CREATE TEMP TABLE surface_touches AS SELECT * FROM delivery_touches;
CREATE TEMP TABLE surface_deliveries AS SELECT rowid AS ordering,* FROM deliveries;
DROP TABLE delivery_touches;
DROP TABLE followups;
DROP TABLE deliveries;
CREATE TABLE deliveries (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', epoch INTEGER NOT NULL,
 ts TEXT NOT NULL, moment TEXT NOT NULL, entry_id TEXT NOT NULL,
 form TEXT NOT NULL CHECK(form IN ('full','one-line','pointer','card')), tokens INTEGER NOT NULL CHECK(tokens>=0),
 action TEXT NOT NULL CHECK(action IN ('given','withheld','replaced','held-back','shadow','control')),
 content_hash TEXT NOT NULL DEFAULT '', block_id TEXT NOT NULL DEFAULT '',
 project_id TEXT NOT NULL DEFAULT '', checkout TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
 title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', level TEXT NOT NULL DEFAULT '',
 surface TEXT NOT NULL DEFAULT 'unknown',
 FOREIGN KEY(session_id,agent_id,epoch) REFERENCES epochs(session_id,agent_id,epoch)
);
INSERT INTO deliveries SELECT id,session_id,agent_id,epoch,ts,moment,entry_id,form,tokens,action,content_hash,block_id,project_id,checkout,detail,title,kind,level,
 CASE moment WHEN 'read' THEN 'read-pitfall' WHEN 'read-risk' THEN 'read-risk'
 WHEN 'edit' THEN 'edit' WHEN 'rejected' THEN 'edit' WHEN 'create' THEN 'edit'
 WHEN 'command' THEN 'command-recipe' WHEN 'failure' THEN 'failure-fix'
 WHEN 'prompt' THEN 'prompt' WHEN 'start-brief' THEN 'start-brief'
 WHEN 'recovery' THEN 'recovery' WHEN 'resume' THEN 'recovery' WHEN 'subagent' THEN 'recovery' WHEN 'brief' THEN 'recovery' WHEN 'carry' THEN 'carry'
 ELSE 'unknown' END FROM surface_deliveries ORDER BY ordering;
CREATE INDEX deliveries_epoch_entry ON deliveries(session_id,agent_id,epoch,entry_id,ts);
CREATE INDEX deliveries_ts ON deliveries(ts);
CREATE INDEX deliveries_presence ON deliveries(session_id,agent_id,epoch,project_id,checkout,entry_id,action);
CREATE INDEX deliveries_surface ON deliveries(project_id,checkout,surface,session_id);
CREATE TABLE followups (
 id INTEGER PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id), ts TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('followed','missed','opened','wrong','edit','command','failure','delivered-later','nothing')), detail TEXT
);
INSERT INTO followups SELECT * FROM surface_followups;
CREATE INDEX followups_delivery ON followups(delivery_id,ts);
CREATE INDEX followups_kind ON followups(kind,delivery_id);
CREATE TABLE delivery_touches (delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id));
INSERT INTO delivery_touches SELECT * FROM surface_touches;
DROP TABLE surface_deliveries;
DROP TABLE surface_followups;
DROP TABLE surface_touches;
DROP TABLE surface_migration_bound;

ALTER TABLE epochs ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls>=0);
ALTER TABLE epochs ADD COLUMN candidate_tokens INTEGER NOT NULL DEFAULT 0 CHECK(candidate_tokens>=0);
ALTER TABLE epochs ADD COLUMN admitted_tokens INTEGER NOT NULL DEFAULT 0 CHECK(admitted_tokens>=0);
ALTER TABLE epochs ADD COLUMN budget_held INTEGER NOT NULL DEFAULT 0 CHECK(budget_held>=0);
ALTER TABLE epochs ADD COLUMN contention_measured INTEGER NOT NULL DEFAULT 0 CHECK(contention_measured IN (0,1));
CREATE TABLE epoch_offers (
 session_id TEXT NOT NULL,agent_id TEXT NOT NULL,epoch INTEGER NOT NULL,
 project_id TEXT NOT NULL,checkout TEXT NOT NULL,entry_id TEXT NOT NULL,
 tokens INTEGER NOT NULL CHECK(tokens>=0),budget_held INTEGER NOT NULL DEFAULT 0 CHECK(budget_held IN (0,1)),
 PRIMARY KEY(session_id,agent_id,epoch,project_id,checkout,entry_id),
 FOREIGN KEY(session_id,agent_id,epoch) REFERENCES epochs(session_id,agent_id,epoch)
);
CREATE TABLE surface_firings (
 id TEXT PRIMARY KEY,session_id TEXT NOT NULL,agent_id TEXT NOT NULL,epoch INTEGER NOT NULL,
 project_id TEXT NOT NULL,checkout TEXT NOT NULL,surface TEXT NOT NULL,action TEXT NOT NULL,repeated INTEGER NOT NULL,
 pending INTEGER NOT NULL DEFAULT 0 CHECK(pending>=0),acted INTEGER NOT NULL DEFAULT 0 CHECK(acted IN (0,1)),
 settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX surface_firings_session ON surface_firings(session_id,agent_id,epoch);
CREATE TABLE surface_windows (
 delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id), session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 epoch INTEGER NOT NULL, project_id TEXT NOT NULL, checkout TEXT NOT NULL,
 expires INTEGER NOT NULL, target TEXT NOT NULL, repeated INTEGER NOT NULL CHECK(repeated IN (0,1)),
 acted INTEGER NOT NULL DEFAULT 0 CHECK(acted IN (0,1)), settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
 firing_id TEXT NOT NULL REFERENCES surface_firings(id)
);
CREATE INDEX surface_windows_pending ON surface_windows(session_id,agent_id,epoch,expires) WHERE settled=0;
CREATE INDEX surface_windows_firing ON surface_windows(firing_id,settled);
CREATE TABLE surface_session_first (
 session_id TEXT NOT NULL, agent_id TEXT NOT NULL, project_id TEXT NOT NULL, checkout TEXT NOT NULL,
 surface TEXT NOT NULL, block_id TEXT NOT NULL,
 PRIMARY KEY(session_id,agent_id,project_id,checkout,surface)
);
CREATE TABLE surface_stats (
 project_id TEXT NOT NULL, checkout TEXT NOT NULL, surface TEXT NOT NULL, action TEXT NOT NULL,
 repeated INTEGER NOT NULL, firings INTEGER NOT NULL DEFAULT 0, settled INTEGER NOT NULL DEFAULT 0,
 acted INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,receipts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(project_id,checkout,surface,action,repeated)
);
CREATE TABLE surface_gates (
 project_id TEXT NOT NULL, surface TEXT NOT NULL,
 minimum_firings INTEGER NOT NULL DEFAULT 30, minimum_rate REAL NOT NULL DEFAULT 0.30,
 wilson_z REAL NOT NULL DEFAULT 1.959963984540054,
 evaluated INTEGER NOT NULL DEFAULT 0, evaluated_acted INTEGER NOT NULL DEFAULT 0,
 evaluated_first INTEGER NOT NULL DEFAULT 0, evaluated_first_acted INTEGER NOT NULL DEFAULT 0,
 evaluated_repeat INTEGER NOT NULL DEFAULT 0, evaluated_repeat_acted INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'collecting' CHECK(state IN ('collecting','pass','fail','off')),
 reason TEXT NOT NULL DEFAULT 'insufficient settled live firings', announced INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(project_id,surface)
);
