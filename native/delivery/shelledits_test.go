package delivery

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestShellTargets(t *testing.T) {
	root := t.TempDir()
	const leaf = "apps/api/src/app/domains/usecases/domain-route.utils.ts"
	for _, tc := range []struct {
		name, command, cwd string
		want               []string
		write              bool
	}{
		{"powershell probe", "(Get-Content -Raw " + leaf + ").Replace(\"  organizationId," + string(rune(96)) + "r" + string(rune(96)) + "n}: {\", \"  organizationId, region,\") | Set-Content -NoNewline " + leaf, "", []string{leaf}, true},
		{"join-path", "$path = Join-Path (Get-Location) '" + leaf + "'; [IO.File]::WriteAllText($path, $new)", "", []string{leaf}, true},
		{"heredoc", "python - <<'PY'\nfrom pathlib import Path\nroot = Path('apps/api/src/app/domains/usecases')\nfor p in root.rglob('*.ts'):\n    p.write_text(p.read_text().replace('old', 'new'))\nPY", "", []string{"apps/api/src/app/domains/usecases"}, true},
		{"perl", "perl -0pi -e 's/organizationId/region/g' $(grep -rl resolveDomainName apps/api/src)", "", []string{"apps/api/src"}, true},
		{"sed", "sed -i 's/a/b/' src/x.ts", "", []string{"src/x.ts"}, true},
		{"read-only sed", "sed -n '1,2p' src/x.ts", "", nil, false},
		{"no paths", "pnpm install", "", nil, true},
		{"cwd, absolute and Windows separators", "tool ..\\src\\x.ts \"" + filepath.Join(root, "spaced dir", "file.ts") + "\"", "sub", []string{"src/x.ts", "spaced dir/file.ts"}, true},
		{"outside checkout", "tool ../other/x.ts \"" + filepath.Join(filepath.Dir(root), "elsewhere", "file.ts") + "\"", "", nil, true},
		{"glob directory", "tool 'src/**/a.ts' ./other/part*.ts *.ts", "pkg", []string{"pkg/src/", "pkg/other/", "pkg/"}, true},
		{"bare extension", "tool x.PYI", "pkg", []string{"pkg/x.PYI"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := contract.Event{Checkout: root, Cwd: filepath.Join(root, tc.cwd), Tool: &contract.Tool{
				Name: contract.ToolShell, Input: contract.ToolInput{Command: tc.command}, Output: &contract.ToolOutput{OK: true},
			}}
			got, write, bounded := shellTargets(event)
			if !bounded || write != tc.write || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("targets = %v, write = %v, bounded = %v; want %v, %v, true", got, write, bounded, tc.want, tc.write)
			}
		})
	}
}

// From a live session: one perl loop updated every caller after a cd. The
// cd folder is where the command runs, not a target, and the glob is in
// that folder, not across the whole checkout.
func TestShellTargetsFollowCd(t *testing.T) {
	root := t.TempDir()
	const dir = "apps/api/src/app/domains/usecases"
	enter := dir
	if runtime.GOOS == "windows" {
		volume := filepath.VolumeName(root)
		enter = "/" + strings.ToLower(volume[:1]) + filepath.ToSlash(root[len(volume):]) + "/" + dir
	}
	for _, tc := range []struct {
		name, command string
		want          []string
	}{
		{"perl loop", "cd " + enter + " && for f in $(grep -rl \"resolveDomainName({\" --include=*.usecase.ts .); do perl -0pi -e 's/a/b/' $f; done; git diff --stat", []string{dir + "/"}},
		{"sed after cd", "cd apps/api && sed -i 's/a\\/b/c/' src/x.ts", []string{"apps/api/src/x.ts"}},
		{"tests in a package", "cd apps/api && pnpm test", nil},
		{"cd into a variable", "cd $ROOT && sed -i 's/a/b/' x.ts", []string{"x.ts"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := contract.Event{Checkout: root, Cwd: root, Tool: &contract.Tool{
				Name: contract.ToolShell, Input: contract.ToolInput{Command: tc.command}, Output: &contract.ToolOutput{OK: true},
			}}
			got, write, bounded := shellTargets(event)
			if !bounded || !write || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("targets = %v, write = %v, bounded = %v; want %v", got, write, bounded, tc.want)
			}
		})
	}
}

func TestRedirectsToFile(t *testing.T) {
	for command, want := range map[string]bool{
		"sed 's/a/b/' x.ts > x.tmp && cat x.tmp > x.ts": true,
		"cat a.ts >> b.ts":            true,
		"grep -n foo src 2>/dev/null": false,
		"rg foo 2>&1":                 false,
		"Get-Content x.ts > $null":    false,
		"cat x.ts > NUL":              false,
		"echo 'a > b.ts'":             false,
		"grep -rn 'x' src":            false,
	} {
		if got := redirectsToFile(command); got != want {
			t.Errorf("redirectsToFile(%q) = %v, want %v", command, got, want)
		}
	}
	ev := contract.Event{Checkout: t.TempDir(), Tool: &contract.Tool{Name: contract.ToolShell, Output: &contract.ToolOutput{OK: true},
		Input: contract.ToolInput{Command: "sed 's/a/b/' area.ts > area.tmp && cat area.tmp > area.ts"}}}
	ev.Cwd = ev.Checkout
	if got, write, _ := shellTargets(ev); !write || !reflect.DeepEqual(got, []string{"area.ts"}) {
		t.Fatalf("targets = %v, write = %v; want [area.ts], true", got, write)
	}
}

func TestRecentlyChangedCode(t *testing.T) {
	f := rescueFixture(t)
	files := map[string][]plantedSymbol{"src/recent.ts": nil, "src/old.ts": nil, "src/backdated.ts": nil, "src/future.ts": nil, "src/unchanged.ts": nil}
	files["src-other/recent.ts"] = nil
	for i := 0; i < maxShellChanged; i++ {
		files[fmt.Sprintf("extra/%d.ts", i)] = nil
	}
	plantIndex(t, f, files)
	now := time.Now().Add(time.Second)
	db, err := sql.Open("sqlite", filepath.Join(index.Directory(f.dir, f.project), "c-test.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("UPDATE paths SET mtime_ns=? WHERE path='src/old.ts'", strconv.FormatInt(now.Add(-time.Hour).UnixNano(), 10))
	if err == nil {
		// An indexed directory with too many files is refused before stats.
		_, err = db.Exec("WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<?) "+
			"INSERT INTO paths SELECT 'many/'||i||'.ts', 'hash', 'ts', 0, 1, '0', NULL, 'file.ts' FROM n", index.MaxRecentCodeCandidates)
	}
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	writeAt := func(path string, at time.Time) { scriptWrote(t, f, path, "export const x = 1\n", at) }
	writeAt("src/recent.ts", now)
	writeAt("src/backdated.ts", now.Add(-time.Minute))
	writeAt("src/future.ts", now.Add(time.Minute))
	writeAt("src/unknown.ts", now)
	writeAt("src-other/recent.ts", now)
	// This change is newer than its parse, but outside the command window.
	writeAt("src/old.ts", now.Add(-10*time.Minute))
	ix, err := index.Open(f.dir, f.project, f.root)
	if err != nil {
		t.Fatal(err)
	}
	defer ix.Close()
	find := func(ctx context.Context, observed map[string]int64) ([]index.RecentCodeFile, bool) {
		return ix.RecentlyChangedCode(ctx, []string{"src", "src/recent.ts", "extra/"}, []string{"src/recent.ts"}, now.Add(-shellCatchWindow), now, maxShellChanged, observed)
	}
	if got, complete := find(t.Context(), nil); !complete || len(got) != 1 || got[0].Path != "src/recent.ts" {
		t.Fatalf("recent changes: %v", got)
	} else if again, complete := find(t.Context(), map[string]int64{got[0].Path: got[0].Mtime}); !complete || len(again) != 0 {
		t.Fatalf("versions already recorded: %v", again)
	}
	// The whole checkout named in passing is past the cap here: the named
	// file is still checked (a live Codex script named "." and a folder).
	if got, complete := ix.RecentlyChangedCode(t.Context(), []string{".", "src/recent.ts"}, nil, now.Add(-shellCatchWindow), now, maxShellChanged, nil); !complete || len(got) != 1 || got[0].Path != "src/recent.ts" {
		t.Fatalf("whole checkout past the cap: %v, complete = %v", got, complete)
	}
	if got, complete := ix.RecentlyChangedCode(t.Context(), []string{"many/"}, nil, now.Add(-shellCatchWindow), now, maxShellChanged, nil); complete || len(got) != 0 {
		t.Fatalf("over candidate cap: %v, complete = %v", got, complete)
	}
	for rel := range files {
		if strings.HasPrefix(rel, "extra/") {
			writeAt(rel, now)
		}
	}
	if got, complete := find(t.Context(), nil); complete || len(got) != 0 {
		t.Fatalf("over cap: %v", got)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if got, complete := find(ctx, nil); complete || len(got) != 0 {
		t.Fatalf("over budget: %v", got)
	}
}

func TestRecentCodeRejectsLinkedFilesOutsideCheckout(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{"src/nested/file.ts": nil})
	now := time.Now().Add(time.Second)
	external := t.TempDir()
	file := filepath.Join(external, "file.ts")
	if err := os.WriteFile(file, []byte("export const x = 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, now, now); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(f.root, "src", "nested")
	if err := os.Remove(filepath.Join(nested, "file.ts")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(nested); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, nested); err != nil {
		t.Skipf("creating a directory symlink: %v", err)
	}
	ix, err := index.Open(f.dir, f.project, f.root)
	if err != nil {
		t.Fatal(err)
	}
	defer ix.Close()
	got, _ := ix.RecentlyChangedCode(t.Context(), []string{"src/"}, nil, now.Add(-shellCatchWindow), now, maxShellChanged, nil)
	if len(got) != 0 {
		t.Fatalf("reported file outside checkout: %v", got)
	}
}

func TestDiffSpans(t *testing.T) {
	patch := `diff --git a/src/a file.ts b/src/a file.ts
--- a/src/a file.ts
+++ b/src/a file.ts` + "\t\n" + `@@ -1,2 +0,0 @@
-old
-old
@@ -3 +2,3 @@ export function f() {
-old
+new
+++ this is content, not a file header
+new
@@ -9 +10 @@
-old
+new
diff --git "a/\303\251.ts" "b/\303\251.ts"
--- "a/\303\251.ts"
+++ "b/\303\251.ts"
@@ -2,2 +1,0 @@
-old
-old
diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+new
`
	want := ChangedLines{"src/a file.ts": {{1, 0}, {2, 4}, {10, 10}}, "é.ts": {{2, 1}}, "new.ts": wholeFile()}
	if got, ok := diffSpans(patch); !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("diff spans: %v (%v), want %v", got, ok, want)
	}
	if got, ok := diffSpans(strings.ReplaceAll(patch, "\n", "\r\n")); !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("CRLF diff spans: %v (%v), want %v", got, ok, want)
	}
	if got, ok := diffSpans("@@ -2 +1,invalid @@\n"); ok {
		t.Fatalf("accepted malformed hunk: %v", got)
	}
}

func TestWorktreeDiffSpansReplaceEarlierCoordinates(t *testing.T) {
	changed := ChangedLines{"a.ts": {{2, 2}}, "b.ts": {{7, 7}}}
	changed.RecordWorktreeDiff(ChangedLines{"a.ts": {{1, 1}, {3, 3}}})
	want := ChangedLines{"a.ts": {{1, 1}, {3, 3}}, "b.ts": {{7, 7}}}
	if !reflect.DeepEqual(changed, want) {
		t.Fatalf("changed spans: %v, want %v", changed, want)
	}
}
