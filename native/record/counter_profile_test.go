package record

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"testing"
	"time"

	"modernc.org/sqlite"
)

// Run explicitly with -run '^$' -bench BenchmarkCounterPhases -benchtime=100x.
// This diagnostic expands the counter opener's DSN pragmas into separate calls
// and uses a fixture deadline, so slow stages are measured rather than dropped.
// It does not measure or change the production deadline. The normal cycle test
// and whole-process timing tests continue to exercise that deadline unchanged.
func BenchmarkCounterPhases(b *testing.B) {
	for _, observed := range []bool{false, true} {
		b.Run(fmt.Sprintf("idle-observer=%t", observed), func(b *testing.B) { benchmarkCounterPhases(b, observed) })
	}
}

func benchmarkCounterPhases(b *testing.B, observed bool) {
	location, err := ResolveLocation(LocationOptions{Home: b.TempDir(), Cache: b.TempDir()})
	if err != nil {
		b.Fatal(err)
	}
	initial, err := openHooks(location, testBudget)
	if err != nil {
		b.Fatal(err)
	}
	if err := initial.Close(); err != nil {
		b.Fatal(err)
	}
	stages := map[string][]time.Duration{}
	if observed {
		reader, err := openCounterReader(location.Hooks)
		if err != nil {
			b.Fatal(err)
		}
		defer reader.Close()
		var version int
		if err := reader.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
			b.Fatal(err)
		}
	}
	order := []string{"pool", "physical-open", "busy-pragma", "foreign-keys-pragma", "synchronous-pragma", "persist-wal", "schema-journal", "readonly-guard", "autocommit-insert", "begin", "transaction-insert", "commit", "close"}
	b.ResetTimer()
	for range b.N {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		step := func(name string, fn func() error) {
			start := time.Now()
			err := fn()
			stages[name] = append(stages[name], time.Since(start))
			if err != nil {
				cancel()
				b.Fatalf("%s: %v", name, err)
			}
		}
		uri, err := databaseURI(location.Hooks)
		if err != nil {
			b.Fatal(err)
		}
		uri.RawQuery = "mode=rwc"
		var db *sql.DB
		var conn *sql.Conn
		step("pool", func() (err error) {
			db, err = sql.Open("sqlite", uri.String())
			if err == nil {
				db.SetMaxOpenConns(1)
			}
			return
		})
		step("physical-open", func() (err error) { conn, err = db.Conn(ctx); return })
		for _, pragma := range []struct{ name, sql string }{
			{"busy-pragma", "PRAGMA busy_timeout=1"},
			{"foreign-keys-pragma", "PRAGMA foreign_keys=ON"},
			{"synchronous-pragma", "PRAGMA synchronous=NORMAL"},
		} {
			step(pragma.name, func() error { _, err := conn.ExecContext(ctx, pragma.sql); return err })
		}
		step("persist-wal", func() error {
			return conn.Raw(func(raw any) error { _, err := raw.(sqlite.FileControl).FileControlPersistWAL("main", 1); return err })
		})
		step("schema-journal", func() error {
			var version int
			var mode string
			if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
				return err
			}
			if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
				return err
			}
			if version != SchemaVersion || mode != "wal" {
				return fmt.Errorf("unexpected schema=%d mode=%s", version, mode)
			}
			return nil
		})
		step("readonly-guard", func() error {
			uri.RawQuery = "mode=ro"
			if _, err := conn.ExecContext(ctx, "ATTACH DATABASE ? AS counter_readonly", uri.String()); err != nil {
				return err
			}
			var version int
			return conn.QueryRowContext(ctx, "PRAGMA counter_readonly.user_version").Scan(&version)
		})
		statement := "INSERT INTO main.counters_go(day,name,value) VALUES('2026-11-13','agent:codex:hook.calls',1),('2026-11-13','agent:codex:hook.ms.0',1) ON CONFLICT(day,name) DO UPDATE SET value=min(2147483647,value+1)"
		// Production uses one atomic statement, including its commit. The second
		// pair separates BEGIN/INSERT/COMMIT to locate filesystem commit cost;
		// it is an explicit diagnostic comparison, not the production algorithm.
		step("autocommit-insert", func() error { _, err := conn.ExecContext(ctx, statement); return err })
		step("begin", func() error { _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); return err })
		step("transaction-insert", func() error { _, err := conn.ExecContext(ctx, statement); return err })
		step("commit", func() error { _, err := conn.ExecContext(ctx, "COMMIT"); return err })
		step("close", func() error {
			if err := conn.Close(); err != nil {
				return err
			}
			return db.Close()
		})
		cancel()
	}
	b.StopTimer()
	for _, name := range order {
		values := stages[name]
		sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
		b.Logf("%s samples=%d p50=%.3fms p95=%.3fms max=%.3fms", name, len(values), float64(values[len(values)/2])/float64(time.Millisecond), float64(values[len(values)*95/100])/float64(time.Millisecond), float64(values[len(values)-1])/float64(time.Millisecond))
	}
	reader, err := openCounterReader(location.Hooks)
	if err != nil {
		b.Fatal(err)
	}
	defer reader.Close()
	var calls, buckets int
	if err := reader.QueryRow("SELECT coalesce(sum(CASE WHEN name='agent:codex:hook.calls' THEN value ELSE 0 END),0), coalesce(sum(CASE WHEN name='agent:codex:hook.ms.0' THEN value ELSE 0 END),0) FROM counters_go").Scan(&calls, &buckets); err != nil || calls != b.N*2 || buckets != calls {
		b.Fatalf("incomplete pairs calls=%d buckets=%d: %v", calls, buckets, err)
	}
}
