package rulechange

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/gitstate"
)

func TestSnapshotBindings(t *testing.T) {
	for _, what := range []string{"valid", "all-reasons", "entry", "branch", "head", "file", "added", "deleted", "duplicate", "escape", "too-many"} {
		t.Run(what, func(t *testing.T) {
			root := t.TempDir()
			put := func(path, text string) {
				t.Helper()
				p := filepath.Join(root, filepath.FromSlash(path))
				if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, []byte(text), 0600); err != nil {
					t.Fatal(err)
				}
			}
			head := strings.Repeat("a", 40)
			put(".git/HEAD", "ref: refs/heads/work\n")
			put(".git/refs/heads/work", head+"\n")
			put("src/a.ts", "new pattern\n")
			s := Snapshot{Version: 1, Checkout: root, Position: gitstate.Position{Branch: "refs/heads/work", Head: head}, Entries: []Signal{{ID: "mx_policy0", EntryHash: "entry", Reasons: []string{"changed"}, Files: []Input{{"src/a.ts", digest([]byte("new pattern\n"))}}, Directories: []Input{{"src", digest([]byte("a.ts"))}}}}}
			entry := "entry"
			switch what {
			case "all-reasons":
				s.Entries[0].Reasons = []string{"pattern", "branch", "commit", "newer policy", "overrides"}
			case "entry":
				entry = "another"
			case "branch":
				put(".git/HEAD", "ref: refs/heads/other\n")
				put(".git/refs/heads/other", head+"\n")
			case "head":
				put(".git/refs/heads/work", strings.Repeat("b", 40)+"\n")
			case "file":
				put("src/a.ts", "different bytes\n")
			case "added":
				put("src/b.ts", "old pattern\n")
			case "deleted":
				if err := os.Remove(filepath.Join(root, "src/a.ts")); err != nil {
					t.Fatal(err)
				}
			case "duplicate":
				s.Entries = append(s.Entries, s.Entries[0])
			case "escape":
				s.Entries[0].Files[0].Path = "../outside"
			case "too-many":
				s.Entries[0].Files = make([]Input, 129)
			}
			if got := s.For("mx_policy0", entry); (got != nil) != (what == "valid" || what == "all-reasons") {
				t.Fatalf("%s: %#v", what, got)
			}
		})
	}
}

func TestReadIsNonInitializing(t *testing.T) {
	root := t.TempDir()
	if Read(root, "project", root) != nil {
		t.Fatal("missing snapshot")
	}
	rows, err := os.ReadDir(root)
	if err != nil || len(rows) != 0 {
		t.Fatal(rows, err)
	}
}

func TestExhaustedProofBudgetDoesNotEraseKnownDoubt(t *testing.T) {
	root := t.TempDir()
	head := strings.Repeat("a", 40)
	for path, text := range map[string]string{".git/HEAD": "ref: refs/heads/work\n", ".git/refs/heads/work": head + "\n"} {
		p := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	text := strings.Repeat("x", 64<<10)
	var files []Input
	for i := 0; i < 129; i++ {
		name := fmt.Sprintf("file-%03d.ts", i)
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		files = append(files, Input{name, digest([]byte(text))})
	}
	s := Snapshot{Version: 1, Checkout: root, Position: gitstate.Position{Branch: "refs/heads/work", Head: head}, Entries: []Signal{
		{ID: "mx_policy0", EntryHash: "first", Reasons: []string{"changed"}, Files: files[:128]},
		{ID: "mx_policy1", EntryHash: "second", Reasons: []string{"changed"}, Files: files[128:]},
	}}
	if s.For("mx_policy0", "first") == nil {
		t.Fatal("first proof missing")
	}
	if got := s.For("mx_policy1", "second"); got == nil || !got.Pending {
		t.Fatal("budget exhaustion erased known rule-change evidence")
	}
}
