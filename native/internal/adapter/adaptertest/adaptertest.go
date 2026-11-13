// Package adaptertest holds the fixture and golden-file checks every agent
// profile runs.
package adaptertest

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
)

var update = flag.Bool("update", false, "rewrite golden files")

// EventName is the agent event a fixture file holds: the part of its name
// before the first "-".
func EventName(file string) string {
	ev, _, _ := strings.Cut(strings.TrimSuffix(filepath.Base(file), ".json"), "-")
	return ev
}

// Golden compares got with a golden file, or rewrites it under -update.
func Golden(t *testing.T, path string, got []byte) {
	t.Helper()
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", path, err)
	}
	want = bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n"))
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs\n--- got\n%s\n--- want\n%s", path, got, want)
	}
}

// PayloadFiles lists the payload fixtures in testdata/payloads.
func PayloadFiles(t *testing.T) []string {
	t.Helper()
	all, err := filepath.Glob(filepath.Join("testdata", "payloads", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	var files []string
	for _, f := range all {
		if !strings.HasSuffix(f, ".event.json") {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		t.Fatal("no payload fixtures")
	}
	return files
}

// ParseFixture parses one fixture by name, without the .json suffix.
func ParseFixture(t *testing.T, p adapter.Profile, name string) contract.Event {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "payloads", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	ev, err := p.Parse(EventName(name), raw)
	if err != nil {
		t.Fatal(err)
	}
	return ev
}

// CheckFixtures runs the checks shared by every profile: each fixture parses
// to its golden event, and each declared event has a fixture.
func CheckFixtures(t *testing.T, p adapter.Profile) {
	t.Helper()
	seen := map[string]bool{}
	for _, f := range PayloadFiles(t) {
		seen[EventName(f)] = true
		t.Run(filepath.Base(f), func(t *testing.T) {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			ev, err := p.Parse(EventName(f), raw)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			got, _ := json.MarshalIndent(ev, "", "  ")
			Golden(t, strings.TrimSuffix(f, ".json")+".event.json", append(got, '\n'))
		})
	}
	for _, s := range p.Capabilities().Kinds {
		if !seen[s.NativeEvent] {
			t.Errorf("no fixture for %s", s.NativeEvent)
		}
	}
	if _, err := p.Parse("NoSuchEvent", []byte(`{}`)); err == nil {
		t.Error("unknown event should fail to parse")
	}
	if _, err := p.Parse(p.Capabilities().Kinds[0].NativeEvent, []byte(`{`)); err == nil {
		t.Error("bad JSON should fail to parse")
	}
}

// ReplyCase is one reply-format check.
type ReplyCase struct {
	Name    string
	Fixture string
	Reply   contract.Reply
	Dropped []string
}

// CheckReplies renders each reply against its fixture and compares the output
// with testdata/replies/<name>.json. Every output must be valid JSON.
func CheckReplies(t *testing.T, p adapter.Profile, cases []ReplyCase) {
	t.Helper()
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			out, dropped := p.Render(ParseFixture(t, p, c.Fixture), c.Reply)
			if !json.Valid(out) {
				t.Fatalf("invalid JSON: %s", out)
			}
			if strings.Join(dropped, ",") != strings.Join(c.Dropped, ",") {
				t.Errorf("dropped = %v, want %v", dropped, c.Dropped)
			}
			Golden(t, filepath.Join("testdata", "replies", c.Name+".json"), out)
		})
	}
}

func Ptr[T any](v T) *T { return &v }
