package record

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// CompactionWindow gives the bounds of the context the host just summarized.
// Use the epoch start and end recorded by the lifecycle, including when the
// restart signal has already arrived.
func (h *Hooks) CompactionWindow(session Session, agent string, epoch int) (from, until time.Time, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	var start, end string
	err = h.db.QueryRowContext(ctx, `SELECT coalesce(p.started_at,s.started_at), e.started_at
		FROM epochs e JOIN sessions s ON s.session_id=e.session_id
		LEFT JOIN epochs p ON p.session_id=e.session_id AND p.agent_id=e.agent_id AND p.epoch=e.epoch-1
		WHERE e.session_id=? AND e.agent_id=? AND e.epoch=? AND e.reason='compact'
		AND s.agent=? AND s.project_id=? AND s.checkout=?`,
		session.SessionID, agent, epoch, session.Agent, session.ProjectID, session.Checkout).Scan(&start, &end)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	from, err = time.Parse(time.RFC3339Nano, start)
	if err == nil {
		until, err = time.Parse(time.RFC3339Nano, end)
	}
	return from, until, err
}

const compactionJournalLimit = 256
const compactionSecond = "2006-01-02T15:04:05"

// CompactionJournal reads the newest eligible capture rows in one epoch,
// without pulling pasted, scripted or unbounded text onto the hook path.
// Journal rows use their session's registered project and checkout.
func (h *Hooks) CompactionJournal(session Session, from, until time.Time) ([]JournalEntry, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	// RFC3339Nano strings don't sort within a second when the fraction is
	// omitted. Filter by whole seconds in SQL and finish the comparison below.
	rows, err := h.db.QueryContext(ctx, `SELECT j.id,j.ts,j.kind,substr(j.text,1,8192),j.exit_code
		FROM journal j JOIN sessions s ON s.session_id=j.session_id
		WHERE j.session_id=? AND s.agent=? AND s.project_id=? AND s.checkout=? AND j.marks=''
		AND substr(j.ts,1,19) BETWEEN ? AND ? AND (j.kind='typed' OR j.exit_code IS NOT NULL)
		ORDER BY j.id DESC LIMIT ?`, session.SessionID, session.Agent, session.ProjectID, session.Checkout,
		from.UTC().Format(compactionSecond), until.UTC().Format(compactionSecond), compactionJournalLimit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var out []JournalEntry
	count := 0
	for rows.Next() {
		count++
		if count > compactionJournalLimit {
			return out, true, nil
		}
		e := JournalEntry{SessionID: session.SessionID}
		var code sql.NullInt64
		if err := rows.Scan(&e.ID, &e.TS, &e.Kind, &e.Text, &code); err != nil {
			return nil, false, err
		}
		at, err := time.Parse(time.RFC3339Nano, e.TS)
		if err != nil || at.Before(from) || at.After(until) {
			continue
		}
		if code.Valid {
			c := int(code.Int64)
			e.ExitCode = &c
		}
		out = append(out, e)
	}
	return out, false, rows.Err()
}

type CompactionQuote struct {
	Row   int64
	At    time.Time
	Kind  string
	Quote string
}

type CompactionFilter struct {
	ProcessedThrough int64
	Quotes           []CompactionQuote
	Partial          bool
}

// ReadCompactionFilter reads the filter's acknowledgment and retained exact
// quotes in one snapshot. The acknowledgment also covers messages for
// which the filter kept no labels, even after the batch has been removed.
func (reader *Reader) ReadCompactionFilter(project, session string, from, until time.Time) (CompactionFilter, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reader.budget.reader)
	defer cancel()
	var out CompactionFilter
	tx, err := reader.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	err = tx.QueryRowContext(ctx, `SELECT CASE WHEN length(CAST(value AS BLOB))<=16 THEN value ELSE '' END
		FROM settings WHERE scope=? AND key=?`, project, "filter.session."+shortHash(session)).Scan(&out.ProcessedThrough)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	if out.ProcessedThrough < 0 || out.ProcessedThrough > 1<<53-1 {
		return out, errors.New("invalid capture filter acknowledgment")
	}
	rows, err := tx.QueryContext(ctx, `WITH batches AS MATERIALIZED (
		SELECT key, value FROM settings WHERE scope=? AND
		(key GLOB 'filter.batch.*' OR key GLOB 'learning.pending.*') AND length(CAST(value AS BLOB))<=524288
		ORDER BY key LIMIT 128
	)
	SELECT DISTINCT c.value->>'$.source.row',c.value->>'$.source.at',c.value->>'$.kind',c.value->>'$.quote'
	FROM batches, json_each(CASE WHEN json_valid(batches.value) THEN
		CASE WHEN batches.value->>'$.version'=1 AND
			(batches.key GLOB 'learning.pending.*' OR batches.value->>'$.phase'='complete')
		THEN batches.value ELSE '{}' END ELSE '{}' END,'$.candidates') c
	WHERE c.type='object' AND c.value->>'$.source.session'=? AND c.value->>'$.source.marks'=''
	AND coalesce(c.value->>'$.source.private_tag',0)=0 AND c.value->>'$.source.note_id' IS NULL
	AND c.value->>'$.kind' IN ('rule','pitfall','decision') AND c.value->>'$.label' IN ('lasting','next-session','unsure')
	AND c.value->>'$.source.row'>0 AND substr(c.value->>'$.source.at',1,19) BETWEEN ? AND ?
	AND length(CAST(c.value->>'$.quote' AS BLOB)) BETWEEN 1 AND 8192
	ORDER BY 1 DESC, 3, 4 LIMIT ?`, project, session, from.UTC().Format(compactionSecond), until.UTC().Format(compactionSecond), compactionJournalLimit+1)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
		if count > compactionJournalLimit {
			out.Partial = true
			break
		}
		var q CompactionQuote
		var stamp string
		if err := rows.Scan(&q.Row, &stamp, &q.Kind, &q.Quote); err != nil {
			return out, err
		}
		q.At, err = time.Parse(time.RFC3339Nano, stamp)
		if err == nil && !q.At.Before(from) && !q.At.After(until) {
			out.Quotes = append(out.Quotes, q)
		}
	}
	return out, rows.Err()
}
