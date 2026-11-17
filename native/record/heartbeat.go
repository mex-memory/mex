package record

import (
	"context"
	"errors"
	"github.com/mex-memory/mex/native/internal/safefile"
	"os"
	"time"
)

// HookHeartbeats is a pure read: status never creates or migrates hooks.db.
// The map lets the caller count file and database sightings of a session once.
func HookHeartbeats(location Location, since time.Time) (map[string]map[string]time.Time, error) {
	info, err := os.Lstat(location.Hooks)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !safefile.Regular(location.Hooks) {
		return nil, errors.New("redirected hooks database")
	}
	db, err := openDatabase(location.Hooks, true)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), ReaderOperationTimeout)
	defer cancel()
	rows, err := db.QueryContext(ctx, `SELECT agent,session_id,last_seen_at FROM sessions WHERE last_seen_at>=? LIMIT 10001`, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]time.Time{}
	n := 0
	for rows.Next() {
		n++
		if n > 10000 {
			return nil, errors.New("heartbeat status bound exceeded")
		}
		var agent, id, stamp string
		if err := rows.Scan(&agent, &id, &stamp); err != nil {
			return nil, err
		}
		seen, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			continue
		}
		if out[agent] == nil {
			out[agent] = map[string]time.Time{}
		}
		out[agent][id] = seen
	}
	return out, rows.Err()
}
