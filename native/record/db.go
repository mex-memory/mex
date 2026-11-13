// Package record owns hooks.db writes and read-only access to Node's record.db.
// Errors are returned to the hook caller, which must allow the agent call on failure.
package record

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"modernc.org/sqlite"
)

const SchemaVersion = 1

// Node's additive usage-reader migration does not change the tables read here.
const RecordSchemaVersion = 3
const ReaderBusyTimeoutMS = 10
const WriterBusyTimeoutMS = 200
const WriterOperationTimeout = 250 * time.Millisecond
const ReaderOperationTimeout = 100 * time.Millisecond

// budget is how long one call may wait. Every exported opener uses hookBudget;
// tests that check correctness rather than timing pass a wider one, so a loaded
// machine can't fail them by being slow.
type budget struct{ writerBusy, writer, reader time.Duration }

var hookBudget = budget{time.Duration(WriterBusyTimeoutMS) * time.Millisecond, WriterOperationTimeout, ReaderOperationTimeout}

//go:embed schema/hooks/*.sql
var schemas embed.FS

type migration struct {
	version int
	sql     string
}

func schemaVersion(ctx context.Context, db *sql.DB) (int, error) {
	var version int
	err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version)
	return version, err
}

func futureSchema(file string, version int, known ...int) error {
	supported := SchemaVersion
	if len(known) > 0 {
		supported = known[0]
	}
	return fmt.Errorf("%s schema version %d is newer than supported version %d; refusing to write; upgrade MEX", file, version, supported)
}

// Each numbered migration has its own transaction including user_version.
func migrate(ctx context.Context, db *sql.DB, migrations []migration) error {
	version, err := schemaVersion(ctx, db)
	if err != nil {
		return err
	}
	if version > SchemaVersion {
		return futureSchema("hooks.db", version)
	}
	for _, step := range migrations {
		conn, err := db.Conn(ctx)
		if err != nil {
			return err
		}
		err = func() error {
			if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
				return err
			}
			defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
			var current int
			if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
				return err
			}
			if current > SchemaVersion {
				return futureSchema("hooks.db", current)
			}
			if current < step.version {
				if step.version != current+1 {
					return fmt.Errorf("missing hooks.db migration %d", current+1)
				}
				if _, err := conn.ExecContext(ctx, step.sql); err != nil {
					return err
				}
				if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", step.version)); err != nil {
					return err
				}
			}
			_, err := conn.ExecContext(ctx, "COMMIT")
			return err
		}()
		_ = conn.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func openDatabase(path string, readOnly bool) (*sql.DB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	slash := filepath.ToSlash(absolute)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	uri := url.URL{Scheme: "file", Path: slash}
	query := url.Values{}
	if readOnly {
		query.Set("mode", "ro")
	} else {
		query.Set("mode", "rwc")
	}
	busyTimeout := WriterBusyTimeoutMS
	if readOnly {
		busyTimeout = ReaderBusyTimeoutMS
	}
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeout))
	query.Add("_pragma", "foreign_keys(1)")
	if readOnly {
		query.Add("_pragma", "query_only(1)")
	} else {
		// WAL with NORMAL sync: commits don't wait on a disk flush while holding the
		// write lock, so concurrent hooks don't starve on a busy disk. A process crash
		// loses nothing; only a power loss can drop the last few receipts.
		query.Add("_pragma", "synchronous(1)")
	}
	uri.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

type Hooks struct {
	db     *sql.DB
	budget budget
}

func OpenHooks(location Location) (*Hooks, error) { return openHooks(location, hookBudget) }

func openHooks(location Location, limits budget) (*Hooks, error) {
	db, err := openDatabase(location.Hooks, false)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), limits.writer)
	defer cancel()
	version, err := schemaVersion(ctx, db)
	if err == nil && version > SchemaVersion {
		err = futureSchema("hooks.db", version)
	}
	if err == nil {
		var mode string
		err = db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode)
		if err == nil && mode != "wal" {
			_, err = db.ExecContext(ctx, "PRAGMA journal_mode=WAL")
		}
	}
	if err == nil && version < SchemaVersion {
		var data []byte
		data, err = schemas.ReadFile("schema/hooks/0001_init.sql")
		if err == nil {
			err = migrate(ctx, db, []migration{{1, string(data)}})
		}
	}
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Hooks{db, limits}, nil
}

func (hooks *Hooks) Close() error { return hooks.db.Close() }

type Session struct {
	SessionID  string `json:"session_id"`
	Agent      string `json:"agent"`
	ProjectID  string `json:"project_id"`
	Checkout   string `json:"checkout"`
	StartedAt  string `json:"started_at"`
	LastSeenAt string `json:"last_seen_at"`
	Paused     bool   `json:"paused"`
}

func (hooks *Hooks) PutSession(session Session) error {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	return hooks.write(ctx, `INSERT INTO sessions(session_id,agent,project_id,checkout,started_at,last_seen_at,paused)
 VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,paused=excluded.paused`,
		session.SessionID, session.Agent, session.ProjectID, session.Checkout, session.StartedAt, session.LastSeenAt, session.Paused)
}

// Short SQLite waits reset its exponential backoff so a stream of other writers
// cannot repeatedly miss each newly released lock. The total wait budget stays
// WriterBusyTimeoutMS; it does not restart with each attempt.
func (hooks *Hooks) write(ctx context.Context, statement string, args ...any) error {
	until := time.Now().Add(hooks.budget.writerBusy)
	if deadline, ok := ctx.Deadline(); ok && deadline.Add(-25*time.Millisecond).Before(until) {
		until = deadline.Add(-25 * time.Millisecond)
	}
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	defer func() {
		_, _ = conn.ExecContext(context.Background(), fmt.Sprintf("PRAGMA busy_timeout=%d", WriterBusyTimeoutMS))
	}()
	for {
		remaining := time.Until(until).Milliseconds()
		if remaining <= 0 {
			if err != nil {
				return err
			}
			return context.DeadlineExceeded
		}
		wait := int64(25)
		if remaining < wait {
			wait = remaining
		}
		if _, err = conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout=%d", wait)); err != nil {
			return err
		}
		_, err = conn.ExecContext(ctx, statement, args...)
		if err == nil {
			return nil
		}
		var sqliteErr *sqlite.Error
		if !errors.As(err, &sqliteErr) || sqliteErr.Code()&255 != 5 {
			return err
		}
		if time.Until(until) <= time.Millisecond {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Millisecond):
		}
	}
}

func (hooks *Hooks) Session(id string) (*Session, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout=%d", ReaderBusyTimeoutMS)); err != nil {
		return nil, err
	}
	defer func() {
		_, _ = conn.ExecContext(context.Background(), fmt.Sprintf("PRAGMA busy_timeout=%d", WriterBusyTimeoutMS))
	}()
	var session Session
	err = conn.QueryRowContext(ctx, "SELECT session_id,agent,project_id,checkout,started_at,last_seen_at,paused FROM sessions WHERE session_id=?", id).
		Scan(&session.SessionID, &session.Agent, &session.ProjectID, &session.Checkout, &session.StartedAt, &session.LastSeenAt, &session.Paused)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &session, nil
}

type Reader struct {
	db      *sql.DB
	Version int
	budget  budget
}
type Project struct {
	ID, RootPath, Kind, CreatedAt string
	Shared                        bool
}

// Missing/busy/incompatible files return errors quickly; callers ignore them and allow the call.
func OpenRecord(location Location) (*Reader, error) { return openRecord(location, hookBudget) }

func openRecord(location Location, limits budget) (*Reader, error) {
	if _, err := os.Stat(location.Record); err != nil {
		return nil, err
	}
	db, err := openDatabase(location.Record, true)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), limits.reader)
	defer cancel()
	version, err := schemaVersion(ctx, db)
	if err == nil && version > RecordSchemaVersion {
		err = futureSchema("record.db", version, RecordSchemaVersion)
	}
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Reader{db, version, limits}, nil
}

func (reader *Reader) Close() error { return reader.db.Close() }

// CheckoutProjectID is the hook path: native path normalization and one indexed
// read, never Git. Only an unregistered checkout may need ResolveProject.
func (reader *Reader) CheckoutProjectID(checkout string) (string, bool, error) {
	_, id, found, err := reader.CheckoutRoot(checkout)
	return id, found, err
}

// CheckoutRoot is CheckoutProjectID plus the registered checkout folder that
// matched (normalized as Node stores it), for a path anywhere inside it.
func (reader *Reader) CheckoutRoot(checkout string) (string, string, bool, error) {
	path, err := realPath(checkout)
	if err != nil {
		return "", "", false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), reader.budget.reader)
	defer cancel()
	requested := path
	query := "SELECT project_id,provisional FROM checkouts WHERE path=?"
	if reader.Version == 0 {
		query = "SELECT project_id,NULL FROM checkouts WHERE path=?"
	}
	for {
		var id string
		var provisional sql.NullString
		err = reader.db.QueryRowContext(ctx, query, path).Scan(&id, &provisional)
		if err != nil && err != sql.ErrNoRows {
			return "", "", false, err
		}
		_, markerErr := os.Stat(filepath.Join(path, ".git"))
		if err == nil && (path == requested || strings.HasPrefix(id, "g-") || provisional.Valid || markerErr == nil) {
			return path, id, true, nil
		}
		if markerErr == nil {
			return "", "", false, nil
		}
		parent := filepath.Dir(path)
		if parent == path {
			return "", "", false, nil
		}
		path = parent
	}
}
func (reader *Reader) Project(id string) (*Project, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reader.budget.reader)
	defer cancel()
	var project Project
	err := reader.db.QueryRowContext(ctx, "SELECT id,root_path,kind,shared,created_at FROM projects WHERE id=?", id).
		Scan(&project.ID, &project.RootPath, &project.Kind, &project.Shared, &project.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &project, nil
}
func (reader *Reader) Setting(scope, key string) (string, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reader.budget.reader)
	defer cancel()
	var value string
	err := reader.db.QueryRowContext(ctx, "SELECT value FROM settings WHERE scope=? AND key=?", scope, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return value, err == nil, err
}
