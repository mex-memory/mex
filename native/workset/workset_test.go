package workset

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/record/place"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func repo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", "a.txt")
	git(t, dir, "commit", "-q", "-m", "first")
	return dir
}

func TestHeadReadsLooseRefsPackedRefsWorktreesAndDetached(t *testing.T) {
	dir := repo(t)
	want := git(t, dir, "rev-parse", "HEAD")
	if branch, commit := Head(dir); branch != "main" || commit != want {
		t.Fatal(branch, commit)
	}
	git(t, dir, "checkout", "-q", "-b", "feature/payments-retry")
	git(t, dir, "pack-refs", "--all")
	if branch, commit := Head(dir); branch != "feature/payments-retry" || commit != want {
		t.Fatal("packed", branch, commit)
	}
	wt := filepath.Join(filepath.Dir(dir), "wt")
	git(t, dir, "worktree", "add", "-q", "-b", "side", wt)
	if branch, commit := Head(wt); branch != "side" || commit != want {
		t.Fatal("worktree", branch, commit)
	}
	git(t, dir, "checkout", "-q", "--detach")
	if branch, commit := Head(dir); branch != "" || commit != want {
		t.Fatal("detached", branch, commit)
	}
	if branch, commit := Head(t.TempDir()); branch != "" || commit != "" {
		t.Fatal("not a repo", branch, commit)
	}
}

func TestStaleAndUsable(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	s := &Set{Version: 1, Branch: "b", Head: "h", Made: now.Add(-time.Minute).Format(time.RFC3339Nano)}
	if s.Stale("b", "h", now) || !s.Usable("b") {
		t.Fatal("fresh set")
	}
	if !s.Stale("b", "other", now) || !s.Usable("b") {
		t.Fatal("a new commit on the same branch is stale but still usable")
	}
	if !s.Stale("c", "h", now) || s.Usable("c") {
		t.Fatal("another branch")
	}
	if !s.Stale("b", "h", now.Add(MaxAge+2*time.Minute)) {
		t.Fatal("old set")
	}
	var missing *Set
	if !missing.Stale("b", "h", now) || missing.Usable("b") {
		t.Fatal("missing set")
	}
}

func TestReadAndRequest(t *testing.T) {
	record := t.TempDir()
	checkout := t.TempDir()
	project := "g-0123456789abcdef01234567"
	if Read(record, project, checkout) != nil {
		t.Fatal("nothing cached yet")
	}
	p, err := Path(record, project, checkout)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(Set{Version: 1, Branch: "main", Seeds: []string{"a.ts"}, Fixes: map[string][2]int64{"a.ts": {4, 1}}})
	if err = os.WriteFile(p, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if s := Read(record, project, checkout); s == nil || s.Seeds[0] != "a.ts" || s.Fixes["a.ts"][0] != 4 {
		t.Fatal(s)
	}
	if err = os.WriteFile(p, []byte(`{"version":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if Read(record, project, checkout) != nil {
		t.Fatal("unknown version")
	}
	if err = Request(record, project, checkout); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(PendingMarker(record)); err != nil {
		t.Fatal("no marker")
	}
	real, _ := place.RealPath(checkout)
	data, err := os.ReadFile(filepath.Join(record, "working-set-requests", project+"~"+place.ShortHash(real)+".json"))
	var req map[string]string
	if err != nil || json.Unmarshal(data, &req) != nil || req["project"] != project || req["root"] != real {
		t.Fatal(string(data), err)
	}
	if Request(record, "../escape", checkout) == nil || Read(record, "a/b", checkout) != nil {
		t.Fatal("project names a path component")
	}
}

func TestFixesTableLookup(t *testing.T) {
	// FNV-1a 64 test vectors; the Node writer is checked against the same ones.
	if pathKey("") != 0xcbf29ce484222325 || pathKey("a") != 0xaf63dc4c8601ec8c {
		t.Fatal("path key")
	}
	record, checkout := t.TempDir(), t.TempDir()
	project := "g-0123456789abcdef01234567"
	real, _ := place.RealPath(checkout)
	rows := map[string][2]uint32{"src/a.ts": {4, 1_700_000_000}, "src/b.ts": {3, 1_700_100_000}, "lib/c.go": {7, 1_700_200_000}}
	keys := []string{"src/a.ts", "src/b.ts", "lib/c.go"}
	sort.Slice(keys, func(i, j int) bool { return pathKey(keys[i]) < pathKey(keys[j]) })
	out := []byte("MXF1")
	for _, k := range keys {
		rec := make([]byte, 16)
		binary.LittleEndian.PutUint64(rec, pathKey(k))
		binary.LittleEndian.PutUint32(rec[8:], rows[k][0])
		binary.LittleEndian.PutUint32(rec[12:], rows[k][1])
		out = append(out, rec...)
	}
	dir := filepath.Join(record, "projects", project, "working-set")
	os.MkdirAll(dir, 0o700)
	if err := os.WriteFile(filepath.Join(dir, place.ShortHash(real)+".fixes"), out, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, k := range keys {
		fx, ok := FixesFor(record, project, real, k)
		if !ok || fx.Count != int(rows[k][0]) || fx.Last.Unix() != int64(rows[k][1]) {
			t.Fatal(k, fx, ok)
		}
	}
	if _, ok := FixesFor(record, project, real, "src/none.ts"); ok {
		t.Fatal("absent file")
	}
	if err := os.WriteFile(filepath.Join(dir, place.ShortHash(real)+".fixes"), []byte("MXF1short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := FixesFor(record, project, real, "src/a.ts"); ok {
		t.Fatal("a malformed table answered")
	}
}
