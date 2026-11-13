package record

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testLocation(t *testing.T) Location {
	t.Helper()
	home := t.TempDir()
	t.Setenv("MEX_HOME", home)
	location, err := ResolveLocation(LocationOptions{Home: home, Cache: t.TempDir(), IsNetwork: func(string) (bool, error) { return false, nil }})
	if err != nil {
		t.Fatal(err)
	}
	return location
}

func TestHooksSchema(t *testing.T) {
	location := testLocation(t)
	hooks, err := OpenHooks(location)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	ctx := context.Background()
	version, err := schemaVersion(ctx, hooks.db)
	if err != nil || version != 1 {
		t.Fatalf("version %d: %v", version, err)
	}
	var mode string
	if err := hooks.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("WAL: %s %v", mode, err)
	}
	var busy int
	if err := hooks.db.QueryRow("PRAGMA busy_timeout").Scan(&busy); err != nil || busy != WriterBusyTimeoutMS {
		t.Fatalf("writer timeout %d: %v", busy, err)
	}
	rows, err := hooks.db.Query("SELECT name FROM sqlite_schema WHERE type='table' AND name!='sqlite_sequence' ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	rows.Close()
	if strings.Join(names, ",") != "counters_go,deliveries,epochs,followups,journal,ledger,notices_shown,outputs,sessions,verdicts" {
		t.Fatal(names)
	}
	session := Session{"s", "test", "f-012345678901234567890123", "/fixture", "now", "later", false}
	if err := hooks.PutSession(session); err != nil {
		t.Fatal(err)
	}
	found, err := hooks.Session("s")
	if err != nil || found == nil || *found != session {
		t.Fatalf("session: %+v %v", found, err)
	}
	if err := hooks.db.QueryRow("PRAGMA busy_timeout").Scan(&busy); err != nil || busy != WriterBusyTimeoutMS {
		t.Fatalf("writer timeout not restored: %d %v", busy, err)
	}
	if _, err := hooks.db.Exec("INSERT INTO verdicts VALUES('p','c','e','invalid','h','now')"); err == nil {
		t.Fatal("invalid verdict accepted")
	}
	if _, err := hooks.db.Exec("INSERT INTO epochs VALUES('s','',0,'now',0)"); err != nil {
		t.Fatal(err)
	}
	if _, err := hooks.db.Exec("INSERT INTO deliveries VALUES('d','s','',0,'now','read','e','invalid',0,'given')"); err == nil {
		t.Fatal("invalid form accepted")
	}
}

func TestMigrations(t *testing.T) {
	for _, older := range []bool{false, true} {
		t.Run(fmt.Sprint(older), func(t *testing.T) {
			location := testLocation(t)
			db, err := openDatabase(location.Hooks, false)
			if err != nil {
				t.Fatal(err)
			}
			if older {
				_, err = db.Exec("CREATE TABLE counters_go(day TEXT NOT NULL,name TEXT NOT NULL,value INTEGER NOT NULL CHECK(value>=0),PRIMARY KEY(day,name)); INSERT INTO counters_go VALUES('day','kept',2)")
				if err != nil {
					t.Fatal(err)
				}
			}
			db.Close()
			hooks, err := OpenHooks(location)
			if err != nil {
				t.Fatal(err)
			}
			defer hooks.Close()
			if older {
				var n int
				if err := hooks.db.QueryRow("SELECT value FROM counters_go WHERE name='kept'").Scan(&n); err != nil || n != 2 {
					t.Fatalf("preserve: %d %v", n, err)
				}
			}
		})
	}
}

func TestMigrationRollbackAndNewer(t *testing.T) {
	location := testLocation(t)
	db, err := openDatabase(location.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	err = migrate(ctx, db, []migration{{1, "CREATE TABLE partial(n); INSERT INTO missing VALUES(1)"}})
	if err == nil {
		t.Fatal("migration succeeded")
	}
	version, _ := schemaVersion(ctx, db)
	if version != 0 {
		t.Fatal(version)
	}
	var n int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_schema WHERE name='partial'").Scan(&n); err != nil || n != 0 {
		t.Fatalf("partial: %d %v", n, err)
	}
	if _, err := db.Exec("PRAGMA user_version=99"); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenHooks(location); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("newer schema: %v", err)
	}
}

func TestReaderOlderMissingBusyNewer(t *testing.T) {
	location := testLocation(t)
	start := time.Now()
	if _, err := OpenRecord(location); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("missing reader waited")
	}
	db, err := openDatabase(location.Record, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE settings(scope,key,value); INSERT INTO settings VALUES('g','k','v')"); err != nil {
		t.Fatal(err)
	}
	reader, err := OpenRecord(location)
	if err != nil {
		t.Fatal(err)
	}
	var busy int
	if err := reader.db.QueryRow("PRAGMA busy_timeout").Scan(&busy); err != nil || busy != ReaderBusyTimeoutMS {
		t.Fatalf("reader timeout %d: %v", busy, err)
	}
	value, found, err := reader.Setting("g", "k")
	if err != nil || !found || value != "v" || reader.Version != 0 {
		t.Fatalf("older: %s %v %v", value, found, err)
	}
	if _, err := reader.db.Exec("INSERT INTO settings VALUES('g','write','no')"); err == nil {
		t.Fatal("reader wrote")
	}
	reader.Close()
	if _, err := db.Exec("BEGIN EXCLUSIVE"); err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	_, err = OpenRecord(location)
	if err == nil {
		t.Fatal("exclusive busy file read")
	}
	if time.Since(start) > time.Second {
		t.Fatal("busy reader waited")
	}
	if _, err := db.Exec("ROLLBACK; PRAGMA user_version=99"); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenRecord(location); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("newer: %v", err)
	}
}

func TestLocation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MEX_HOME", home)
	cache := t.TempDir()
	calls := 0
	options := LocationOptions{Home: home, Cache: cache, IsNetwork: func(string) (bool, error) { calls++; return true, nil }}
	first, err := ResolveLocation(options)
	if err != nil {
		t.Fatal(err)
	}
	if first.Directory == first.Home {
		t.Fatal("network database left at home")
	}
	pointer, err := os.ReadFile(filepath.Join(home, "location"))
	if err != nil || string(pointer) != first.Directory+"\n" {
		t.Fatalf("pointer: %q %v", pointer, err)
	}
	options.IsNetwork = func(string) (bool, error) { t.Fatal("cached detector called"); return false, nil }
	second, err := ResolveLocation(options)
	if err != nil || first != second || calls != 1 {
		t.Fatalf("cached: %+v %v", second, err)
	}
	if err := os.Remove(first.Directory); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveLocation(options); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(first.Directory); err != nil {
		t.Fatal(err)
	}
	failed, err := ResolveLocation(LocationOptions{Home: t.TempDir(), Cache: cache, IsNetwork: func(string) (bool, error) { return false, errors.New("unavailable") }})
	if err != nil || failed.Home != failed.Directory {
		t.Fatalf("detection fallback: %+v %v", failed, err)
	}
}

func TestFolderFallback(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("MEX_HOME", t.TempDir())
	project, err := resolveProject(directory, func(string, ...string) (string, error) { return "", errors.New("git missing") })
	if err != nil || project.Kind != "folder" || project.ID != "f-"+shortHash(project.RootPath) {
		t.Fatalf("folder: %+v %v", project, err)
	}
}

func TestHomeUsesMexHomeAsBase(t *testing.T) {
	base := t.TempDir()
	t.Setenv("MEX_HOME", base)
	home, err := homeDir()
	want, _ := absolutePath(filepath.Join(base, ".mex"))
	if err != nil || home != want {
		t.Fatalf("home %s want %s: %v", home, want, err)
	}
}

func TestCheckoutLookupWithoutGit(t *testing.T) {
	location := testLocation(t)
	checkout := t.TempDir()
	path, err := realPath(checkout)
	if err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(checkout, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(checkout, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := openDatabase(location.Record, false)
	if err != nil {
		t.Fatal(err)
	}
	id := "g-012345678901234567890123"
	if _, err := db.Exec("CREATE TABLE checkouts(path TEXT UNIQUE,project_id TEXT,provisional TEXT); PRAGMA user_version=1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO checkouts VALUES(?,?,NULL)", path, id); err != nil {
		t.Fatal(err)
	}
	db.Close()
	reader, err := OpenRecord(location)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	t.Setenv("PATH", "")
	for _, candidate := range []string{checkout, child} {
		got, found, err := reader.CheckoutProjectID(candidate)
		if err != nil || !found || got != id {
			t.Fatalf("lookup %s/%v: %v", got, found, err)
		}
	}
	if err := os.Mkdir(filepath.Join(child, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, found, err := reader.CheckoutProjectID(child); err != nil || found {
		t.Fatalf("unregistered nested repository: %v/%v", found, err)
	}
}

func TestBusyHookWriteFailsOpen(t *testing.T) {
	location := testLocation(t)
	hooks, err := OpenHooks(location)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	lock, err := openDatabase(location.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if _, err := lock.Exec("BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec("ROLLBACK")
	start := time.Now()
	err = hooks.PutSession(Session{SessionID: "blocked", Agent: "test", ProjectID: "p", Checkout: "/fixture", StartedAt: "now", LastSeenAt: "now"})
	if err == nil {
		t.Fatal("busy writer unexpectedly wrote")
	}
	elapsed := time.Since(start)
	if elapsed > WriterOperationTimeout {
		t.Fatal("busy hook waited")
	}
	if elapsed < time.Duration(WriterBusyTimeoutMS)*time.Millisecond/2 {
		t.Fatal("writer did not get its configured contention window")
	}
	t.Logf("locked writer returns an ignorable error after %.3f ms (bound %s)", float64(elapsed.Nanoseconds())/1e6, WriterOperationTimeout)
}

// TestPeer is a test-only process bridge, never shipped as a CLI or shim.
func TestPeer(t *testing.T) {
	mode := os.Getenv("MEX_RECORD_TEST_PEER")
	if mode == "" {
		return
	}
	home := os.Getenv("MEX_HOME")
	cache := os.Getenv("MEX_RECORD_TEST_CACHE")
	options := LocationOptions{Home: home, Cache: cache, IsNetwork: func(string) (bool, error) { return true, nil }}
	if mode == "location-env" {
		options.Home = ""
	}
	if mode == "identity" {
		data, err := os.ReadFile(os.Getenv("MEX_RECORD_TEST_FIXTURES"))
		if err != nil {
			t.Fatal(err)
		}
		var expected []ProjectIdentity
		if err := json.Unmarshal(data, &expected); err != nil {
			t.Fatal(err)
		}
		for _, want := range expected {
			got, err := ResolveProject(want.RootPath)
			if err != nil || got != want {
				t.Fatalf("identity: got %+v want %+v: %v", got, want, err)
			}
		}
		return
	}
	location, err := ResolveLocation(options)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(location)
	ready := func() {
		if err := os.WriteFile(os.Getenv("MEX_RECORD_TEST_READY"), encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if mode != "hooks-write" {
		ready()
	}
	switch mode {
	case "location-env":
		return
	case "checkout-read":
		reader, err := OpenRecord(location)
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		data, err := os.ReadFile(os.Getenv("MEX_RECORD_TEST_FIXTURES"))
		if err != nil {
			t.Fatal(err)
		}
		var fixtures []struct {
			Path string `json:"path"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(data, &fixtures); err != nil {
			t.Fatal(err)
		}
		for _, fixture := range fixtures {
			id, found, err := reader.CheckoutProjectID(fixture.Path)
			if err != nil || id != fixture.ID || found != (fixture.ID != "") {
				t.Fatalf("checkout: got %s/%v want %s: %v", id, found, fixture.ID, err)
			}
		}
	case "hooks-write":
		hooks, err := OpenHooks(location)
		if err != nil {
			t.Fatal(err)
		}
		defer hooks.Close()
		// The WAL reader fixture must not race journal setup/schema migration.
		// Readiness means the database is usable, not only that its path exists.
		ready()
		for index := 0; index < 150; index++ {
			err := hooks.PutSession(Session{SessionID: fmt.Sprint(index), Agent: "test", ProjectID: "fixture", Checkout: "/fixture", StartedAt: "now", LastSeenAt: "now"})
			if err != nil {
				t.Fatal(err)
			}
			time.Sleep(2 * time.Millisecond)
		}
	case "record-read":
		reader, err := OpenRecord(location)
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		project, err := reader.Project(os.Getenv("MEX_RECORD_TEST_PROJECT"))
		if err != nil || project == nil {
			t.Fatalf("project: %+v %v", project, err)
		}
		seen := map[string]bool{}
		for attempt := 0; attempt < 5000; attempt++ {
			value, found, err := reader.Setting("interop", "progress")
			if err != nil {
				t.Fatal(err)
			}
			if found {
				seen[value] = true
				if value == "done" {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
		}
		if !seen["done"] || len(seen) < 2 {
			t.Fatalf("did not observe live Node writes: %v", seen)
		}
	default:
		t.Fatalf("unknown peer mode %s", mode)
	}
}
