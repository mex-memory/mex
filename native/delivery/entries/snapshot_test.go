package entries

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

type codecCase struct {
	Name        string
	Accept      bool
	Content     string
	ExpectedSaw map[string]any
}

func fixtures(t *testing.T) []codecCase {
	t.Helper()
	b, err := os.ReadFile("testdata/codec.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []codecCase
	if json.Unmarshal(b, &cases) != nil {
		t.Fatal("bad fixture JSON")
	}
	return cases
}
func TestCodecParityFixtures(t *testing.T) {
	for _, tc := range fixtures(t) {
		t.Run(tc.Name, func(t *testing.T) {
			e, err := Parse([]byte(tc.Content))
			if (err == nil) != tc.Accept {
				t.Fatalf("accept=%t entry=%v error=%v", tc.Accept, e, err)
			}
			if tc.ExpectedSaw != nil && (e == nil || len(e.Checks) == 0 || !reflect.DeepEqual(e.Checks[0].Saw, tc.ExpectedSaw)) {
				t.Fatal("observation changed meaning", e)
			}
		})
	}
}
func TestSnapshotStoresAndInvalidation(t *testing.T) {
	root, home, dir := t.TempDir(), t.TempDir(), t.TempDir()
	team := filepath.Join(root, ".mex", "learned", "rule")
	notes := filepath.Join(home, "projects", "project", "notes")
	hints := filepath.Join(home, "projects", "project", "hints")
	for _, p := range []string{team, notes, hints} {
		os.MkdirAll(p, 0700)
	}
	valid := fixtures(t)[0].Content
	put := func(dir, id, content string) {
		t.Helper()
		p := filepath.Join(dir, id+".md")
		os.WriteFile(p, []byte(content), 0600)
		past := time.Now().Add(-5 * time.Second)
		os.Chtimes(p, past, past)
	}
	put(team, "mx_abcdef", valid)
	put(notes, "mx_abcdef", valid)
	put(hints, "mx_abcdef", valid)
	put(team, "mx_ghijkl", valid) // filename mismatch withheld
	for _, tc := range fixtures(t) {
		if tc.Name == "valid retired" {
			put(team, "mx_retire", replaceID(tc.Content, "mx_retire"))
		}
	}
	first, err := Load(dir, home, "project", root)
	if err != nil || len(first.Items) != 3 || first.Parsed != 5 || len(first.Retired) != 1 {
		t.Fatal(first, err)
	}
	warm, err := Load(dir, home, "project", root)
	if err != nil || warm.Parsed != 0 || warm.Reused != 5 {
		t.Fatal(warm, err)
	}
	if !warm.Items[0].Scopes[0].MatchString("src/a.ts") || warm.Items[0].Scopes[0].MatchString("test/a.ts") {
		t.Fatal("scope dialect")
	}
	if !warm.Items[2].NeedsHintGate {
		t.Fatal("hint was authorized by cache")
	}
	put(team, "mx_abcdef", replaceText(valid, "Updated claim."))
	changed, err := Load(dir, home, "project", root)
	if err != nil || changed.Parsed != 1 || changed.Items[0].Hash == warm.Items[0].Hash {
		t.Fatal(changed, err)
	}
	os.Remove(filepath.Join(notes, "mx_abcdef.md"))
	deleted, err := Load(dir, home, "project", root)
	if err != nil || len(deleted.Items) != 2 {
		t.Fatal(deleted, err)
	}
	os.WriteFile(CachePath(dir, "project", root), []byte("broken"), 0600)
	rebuilt, err := Load(dir, home, "project", root)
	if err != nil || len(rebuilt.Items) != 2 {
		t.Fatal(rebuilt, err)
	}
	if _, err = Load(dir, home, "../escape", root); err == nil {
		t.Fatal("project traversal")
	}
}
func replaceID(s, id string) string { return strings.ReplaceAll(s, "mx_abcdef", id) }
func replaceText(s, text string) string {
	return strings.ReplaceAll(s, "Use the project logger because it records structured events.", text)
}
func TestSnapshotRefusesRedirectsAndDuplicates(t *testing.T) {
	for _, mode := range []string{"directory", "leaf", "duplicate", "oversize"} {
		t.Run(mode, func(t *testing.T) {
			root, home, dir := t.TempDir(), t.TempDir(), t.TempDir()
			team := filepath.Join(root, ".mex", "learned")
			os.MkdirAll(team, 0700)
			valid := []byte(fixtures(t)[0].Content)
			switch mode {
			case "directory":
				os.Rename(team, team+"-real")
				if err := os.Symlink(team+"-real", team); err != nil {
					t.Skip("symlinks unavailable")
				}
			case "leaf":
				outside := filepath.Join(home, "mx_abcdef.md")
				os.WriteFile(outside, valid, 0600)
				if err := os.Symlink(outside, filepath.Join(team, "mx_abcdef.md")); err != nil {
					t.Skip("symlinks unavailable")
				}
			case "duplicate":
				os.WriteFile(filepath.Join(team, "mx_abcdef.md"), valid, 0600)
				os.Mkdir(filepath.Join(team, "rule"), 0700)
				os.WriteFile(filepath.Join(team, "rule", "mx_abcdef.md"), valid, 0600)
			case "oversize":
				os.WriteFile(filepath.Join(team, "mx_abcdef.md"), make([]byte, MaxEntryBytes+1), 0600)
			}
			if _, err := Load(dir, home, "project", root); err == nil {
				t.Fatal("unsafe store accepted")
			}
		})
	}
}
func TestSnapshotTiming(t *testing.T) {
	if os.Getenv("MEX_DELIVERY_MEASURE") != "1" {
		t.Skip("opt-in measurement")
	}
	root, home, dir := t.TempDir(), t.TempDir(), t.TempDir()
	team := filepath.Join(root, ".mex", "learned")
	os.MkdirAll(team, 0700)
	valid := fixtures(t)[0].Content
	for i := 0; i < 500; i++ {
		id := fmt.Sprintf("mx_%06d", i)
		p := filepath.Join(team, id+".md")
		os.WriteFile(p, []byte(replaceID(valid, id)), 0600)
		past := time.Now().Add(-5 * time.Second)
		os.Chtimes(p, past, past)
	}
	cold := time.Now()
	s, err := Load(dir, home, "project", root)
	elapsed := time.Since(cold)
	if err != nil || len(s.Items) != 500 {
		t.Fatal(len(s.Items), err)
	}
	var times []time.Duration
	for i := 0; i < 200; i++ {
		start := time.Now()
		s, err = Load(dir, home, "project", root)
		times = append(times, time.Since(start))
		if err != nil || s.Parsed != 0 {
			t.Fatal(err, s.Parsed)
		}
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	t.Logf("500 entries: cold (1 run) %s; unchanged (200 runs) p50 %s p95 %s; full form estimate %d tokens", elapsed, times[99], times[189], s.Items[0].FullTokens)
}
