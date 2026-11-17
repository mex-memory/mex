package delivery

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

func fnv(p string) uint64 {
	h := uint64(0xcbf29ce484222325)
	for i := 0; i < len(p); i++ {
		h ^= uint64(p[i])
		h *= 0x100000001b3
	}
	return h
}

// plantFixes writes the fix table the background job writes, for the
// fixture's canonical checkout.
func plantFixes(t *testing.T, f *fixture, fixes map[string][2]int64) {
	t.Helper()
	type row struct {
		key         uint64
		count, last uint32
	}
	var rows []row
	for p, v := range fixes {
		rows = append(rows, row{fnv(p), uint32(v[0]), uint32(v[1])})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].key < rows[j].key })
	out := []byte("MXF1")
	for _, r := range rows {
		rec := make([]byte, 16)
		binary.LittleEndian.PutUint64(rec, r.key)
		binary.LittleEndian.PutUint32(rec[8:], r.count)
		binary.LittleEndian.PutUint32(rec[12:], r.last)
		out = append(out, rec...)
	}
	dir := filepath.Join(f.dir, "projects", f.project, "working-set")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, place.ShortHash(f.root)+".fixes"), out, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestBugHistoryNotice(t *testing.T) {
	f := rescueFixture(t)
	now := f.now
	ago := func(d time.Duration) int64 { return now.Add(-d).Unix() }
	plantFixes(t, f, map[string][2]int64{
		"src/a.ts": {4, ago(15 * 24 * time.Hour)}, "src/b.ts": {3, ago(2 * 24 * time.Hour)}, "src/c.ts": {5, ago(40 * 24 * time.Hour)},
		"src/d.ts": {6, ago(100 * 24 * time.Hour)}, "src/few.ts": {2, ago(time.Hour)}, "src/old.ts": {9, ago(200 * 24 * time.Hour)},
	})
	env := rescueEnv(f, "on")
	send := func(rel string) string {
		return sendWith(t, f.event(contract.PostToolBatch, edit(f.file(rel, "a"), "b")), env)
	}
	if out := send("src/a.ts"); !strings.Contains(out, "History: src/a.ts was fixed 4 times, the last 2 weeks ago.") {
		t.Fatal(out)
	}
	if out := send("src/a.ts"); out != "" {
		t.Fatal("once per file per session", out)
	}
	for _, rel := range []string{"src/few.ts", "src/old.ts"} {
		if out := send(rel); out != "" {
			t.Fatal(rel, out)
		}
	}
	if out := send("src/b.ts"); !strings.Contains(out, "fixed 3 times, the last 2 days ago.") {
		t.Fatal(out)
	}
	if out := send("src/c.ts"); !strings.Contains(out, "the last 5 weeks ago.") {
		t.Fatal(out)
	}
	if out := send("src/d.ts"); out != "" {
		t.Fatal("at most three per session", out)
	}
	f.session = "next-session"
	if out := send("src/d.ts"); !strings.Contains(out, "fixed 6 times, the last 3 months ago.") {
		t.Fatal(out)
	}
}

func TestBugHistoryStartsInShadow(t *testing.T) {
	f := rescueFixture(t)
	plantFixes(t, f, map[string][2]int64{"src/a.ts": {4, f.now.Add(-24 * time.Hour).Unix()}})
	if out := sendWith(t, f.event(contract.PostToolBatch, edit(f.file("src/a.ts", "a"), "b")), f.env()); out != "" {
		t.Fatal(out)
	}
	if rows := f.rows("surface='bug-history'"); len(rows) != 1 || !strings.Contains(rows[0], ":shadow:") {
		t.Fatal(rows)
	}
}

func TestTestCommandsAndHistoryPaths(t *testing.T) {
	for cmd, want := range map[string]bool{"npm test": true, "pnpm run test -- a": true, "go test ./...": true, "cd x && pytest -q": true, "make check": true,
		"cargo nextest run": true, "npm run build": false, "echo test": false, "git log": false, "latest": false} {
		if testCommand(cmd) != want {
			t.Error(cmd)
		}
	}
	f := rescueFixture(t)
	f.file("src/a.ts", "a")
	got := historyPaths("git log -p -- src/a.ts && git blame src/a.ts", f.root, f.root)
	if strings.Join(got, ",") != "src/a.ts" {
		t.Fatal(got)
	}
	if got := historyPaths("cat src/a.ts", f.root, f.root); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestAgeText(t *testing.T) {
	day := 24 * time.Hour
	for d, want := range map[time.Duration]string{time.Hour: "less than a day ago", day: "1 day ago", 13 * day: "13 days ago", 14 * day: "2 weeks ago", 59 * day: "8 weeks ago", 60 * day: "2 months ago"} {
		if got := ageText(d); got != want {
			t.Error(d, got)
		}
	}
}
