-- The journal also records which files a main-agent edit changed (kind
-- 'edit': the repo-relative path only). kind has a CHECK constraint, so the
-- table is rebuilt with its rows, ids, index and id allocation point.
CREATE TABLE journal_next (
 id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(session_id), ts TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('typed','command','edit')), text TEXT NOT NULL, exit_code INTEGER,
 marks TEXT NOT NULL DEFAULT '' CHECK(marks IN ('','pasted','scripted','pasted,scripted'))
);
INSERT INTO journal_next(id,session_id,ts,kind,text,exit_code,marks)
 SELECT id,session_id,ts,kind,text,exit_code,marks FROM journal ORDER BY id;
-- Journal ids are never reused after pruning: journal.consumed is a cursor.
DELETE FROM sqlite_sequence WHERE name='journal_next';
INSERT INTO sqlite_sequence(name,seq) SELECT 'journal_next',
 max(coalesce((SELECT seq FROM sqlite_sequence WHERE name='journal'),0), coalesce((SELECT max(id) FROM journal_next),0));
DROP TABLE journal;
ALTER TABLE journal_next RENAME TO journal;
CREATE INDEX journal_session_id ON journal(session_id,id);

-- Retention (90 days or 200 MB) reads this running total instead of summing
-- the table. A row counts its text, session id and timestamp, plus 16 bytes.
CREATE TABLE journal_size (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL CHECK(bytes>=0));
INSERT INTO journal_size(id,bytes) SELECT 1, coalesce(sum(length(CAST(text AS BLOB))+length(CAST(session_id AS BLOB))+length(CAST(ts AS BLOB))+16),0) FROM journal;
CREATE TRIGGER journal_size_insert AFTER INSERT ON journal BEGIN
 UPDATE journal_size SET bytes=bytes+length(CAST(NEW.text AS BLOB))+length(CAST(NEW.session_id AS BLOB))+length(CAST(NEW.ts AS BLOB))+16 WHERE id=1;
END;
CREATE TRIGGER journal_size_delete AFTER DELETE ON journal BEGIN
 UPDATE journal_size SET bytes=max(0,bytes-length(CAST(OLD.text AS BLOB))-length(CAST(OLD.session_id AS BLOB))-length(CAST(OLD.ts AS BLOB))-16) WHERE id=1;
END;
