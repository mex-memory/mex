package index

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/record/place"
)

func BenchmarkRecentlyChangedCodeDeepTree(b *testing.B) {
	root, err := place.RealPath(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	recordDirectory := b.TempDir()
	const project = "project"
	dir := Directory(recordDirectory, project)
	if err := os.MkdirAll(filepath.Join(dir, "checkouts"), 0o700); err != nil {
		b.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "index.db"))
	if err != nil {
		b.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE paths(path TEXT PRIMARY KEY, hash TEXT, lang TEXT, mtime_ns TEXT, reason TEXT, name TEXT) WITHOUT ROWID`); err != nil {
		b.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		b.Fatal(err)
	}
	now := time.Now()
	old := now.Add(-time.Hour).Truncate(time.Second)
	mtime := strconv.FormatInt(old.UnixNano(), 10)
	for i := 0; i < 2500; i++ {
		folder := fmt.Sprintf("apps/api/pkg%02d/src/modules/group%02d/features/feature%02d/usecases", i/100, i/10%10, i%10)
		if err := os.MkdirAll(filepath.Join(root, folder), 0o700); err != nil {
			b.Fatal(err)
		}
		for j := 0; j < 4; j++ {
			name := fmt.Sprintf("file%03d.ts", j)
			rel := folder + "/" + name
			file := filepath.Join(root, filepath.FromSlash(rel))
			if err := os.WriteFile(file, []byte("export const x = 1\n"), 0o600); err != nil {
				b.Fatal(err)
			}
			if err := os.Chtimes(file, old, old); err != nil {
				b.Fatal(err)
			}
			if _, err := tx.Exec(`INSERT INTO paths VALUES(?, 'hash', 'ts', ?, NULL, ?)`, rel, mtime, name); err != nil {
				b.Fatal(err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	db.Close()
	pointer, err := json.Marshal(Pointer{Version: StoreVersion, Root: root, Snapshot: "index.db", Base: "index.db"})
	if err != nil {
		b.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "checkouts", place.ShortHash(root)+".json"), pointer, 0o600); err != nil {
		b.Fatal(err)
	}
	const target = "apps/api/pkg00/src/modules/group00"
	const changed = target + "/features/feature00/usecases/file000.ts"
	if err := os.Chtimes(filepath.Join(root, filepath.FromSlash(changed)), now, now); err != nil {
		b.Fatal(err)
	}
	var openTime, scanTime time.Duration
	for b.Loop() {
		start := time.Now()
		ix, err := Open(recordDirectory, project, root)
		if err != nil {
			b.Fatal(err)
		}
		openTime += time.Since(start)
		start = time.Now()
		ctx, cancel := context.WithTimeout(b.Context(), time.Second)
		got, complete := ix.RecentlyChangedCode(ctx, []string{target}, nil, now.Add(-2*time.Minute), now.Add(time.Second), 32, nil)
		scanTime += time.Since(start)
		cancel()
		ix.Close()
		if !complete || len(got) != 1 || got[0].Path != changed {
			b.Fatalf("targeted scan = %v, complete = %v", got, complete)
		}
	}
	b.ReportMetric(float64(openTime)/float64(b.N)/1e6, "open-ms")
	b.ReportMetric(float64(scanTime)/float64(b.N)/1e6, "scan-ms")
}
