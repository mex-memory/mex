-- Rebuilding preserves the six existing kinds and every historical row/id.
-- Refuse an oversized migration before copying; the writer's deadline also
-- bounds lock time. A failed check rolls back SQL and user_version together.
CREATE TEMP TABLE followups_migration_bound (n INTEGER CHECK(n<=100000));
INSERT INTO followups_migration_bound SELECT count(*) FROM (SELECT 1 FROM followups LIMIT 100001);
DROP TABLE followups_migration_bound;
CREATE TABLE followups_next (
 id INTEGER PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id), ts TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('followed','missed','opened','wrong','edit','command','failure','delivered-later','nothing')), detail TEXT
);
INSERT INTO followups_next SELECT id,delivery_id,ts,kind,detail FROM followups;
DROP TABLE followups;
ALTER TABLE followups_next RENAME TO followups;
CREATE INDEX followups_delivery ON followups(delivery_id,ts);
CREATE INDEX followups_kind ON followups(kind,delivery_id);
