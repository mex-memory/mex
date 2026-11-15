package check

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
)

type memoryStore struct {
	rows map[string]localrecord.Verdict
	puts int
}

func (m *memoryStore) Verdicts(string, string) (map[string]localrecord.Verdict, error) {
	out := map[string]localrecord.Verdict{}
	for k, v := range m.rows {
		out[k] = v
	}
	return out, nil
}

func (m *memoryStore) PutVerdicts(_, _ string, vs []localrecord.Verdict) error {
	for _, v := range vs {
		m.rows[v.EntryID] = v
		m.puts++
	}
	return nil
}

func (m *memoryStore) DropVerdicts(_, _ string, keep []string) error {
	kept := map[string]bool{}
	for _, id := range keep {
		kept[id] = true
	}
	for id := range m.rows {
		if !kept[id] {
			delete(m.rows, id)
		}
	}
	return nil
}

// teamEntry writes a team entry whose checks were recorded on today's files.
func teamEntry(t *testing.T, root, id string, checks ...Check) {
	t.Helper()
	var b strings.Builder
	b.WriteString("---\nmex:\n  id: " + id + "\n  kind: fact\n  scope: [\"**\"]\n  source: {type: config, ref: package.json}\n  evidence: mined\n  one_line: x\n  checks:\n")
	for _, c := range checks {
		b.WriteString("    - kind: " + c.Kind + "\n      role: " + c.Role + "\n      target: {")
		var parts []string
		for k, v := range c.Target {
			parts = append(parts, k+": \""+v.(string)+"\"")
		}
		b.WriteString(strings.Join(parts, ", ") + "}\n      saw: {")
		parts = nil
		for k, v := range c.Saw {
			parts = append(parts, k+": \""+v.(string)+"\"")
		}
		b.WriteString(strings.Join(parts, ", ") + "}\n      files: {")
		parts = nil
		for k, v := range c.Files {
			parts = append(parts, "\""+k+"\": \""+v+"\"")
		}
		b.WriteString(strings.Join(parts, ", ") + "}\n")
	}
	b.WriteString("  status: active\n  created: 2026-11-14\n---\nText.\n")
	write(t, root, ".mex/learned/"+id+".md", b.String())
}

func TestStage(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	write(t, root, "package.json", pkg)
	write(t, root, "CONTRIBUTING.md", contributing)
	teamEntry(t, root, "mx_script", record(t, root, "key", Complete, map[string]any{"file": "package.json", "pointer": "/scripts/test"}))
	teamEntry(t, root, "mx_devbox", record(t, root, "section", Complete, map[string]any{"file": "CONTRIBUTING.md", "heading": "Dev container"}))
	write(t, home, "projects/p1/notes/mx_mynote.md", strings.ReplaceAll(entryFile, "mx_7f3k2a", "mx_mynote"))
	write(t, root, ".mex/learned/mx_broken.md", "not an entry")
	store := &memoryStore{rows: map[string]localrecord.Verdict{"mx_deleted": {EntryID: "mx_deleted", Verdict: "held"}}}
	opts := StageOptions{Checkout: root, ProjectID: "p1", MexHome: home, Store: store, Now: time.Date(2026, 11, 14, 9, 0, 0, 0, time.UTC)}

	r, err := RunStage(opts)
	if err != nil {
		t.Fatal(err)
	}
	// The note's recorded file hash is stale, but its key still holds.
	if r.Entries != 3 || r.Invalid != 1 || r.Evaluated != 3 || r.Counts[Held] != 3 {
		t.Fatalf("first run: %+v", r)
	}
	if _, kept := store.rows["mx_deleted"]; kept || len(store.rows) != 3 || store.rows["mx_script"].CheckedAt != "2026-11-14T09:00:00Z" {
		t.Fatalf("cache: %+v", store.rows)
	}

	// Nothing changed: nothing re-runs.
	if r, _ := RunStage(opts); r.Evaluated != 0 || r.Reused != 3 {
		t.Fatalf("second run: %+v", r)
	}

	// A formatting-only change re-runs that entry once, stays held, and is
	// then reused.
	write(t, root, "package.json", strings.ReplaceAll(pkg, "  ", "\t"))
	if r, _ := RunStage(opts); r.Evaluated != 2 || r.Counts[Held] != 3 {
		t.Fatalf("reformatted: %+v", r) // the script entry and the note both read package.json
	}
	if r, _ := RunStage(opts); r.Evaluated != 0 {
		t.Fatalf("re-recorded: %+v", r)
	}

	// After an edit, only entries that read the edited file run.
	write(t, root, "CONTRIBUTING.md", strings.Replace(contributing, "Node 22", "Node 24", 1))
	edited := opts
	edited.Paths = []string{"CONTRIBUTING.md"}
	r, _ = RunStage(edited)
	if r.Evaluated != 1 || r.Results[0].EntryID != "mx_devbox" || r.Results[0].Verdict != Broken || store.rows["mx_devbox"].Verdict != Broken {
		t.Fatalf("edit: %+v", r)
	}
	// Editing the entry itself re-runs it.
	teamEntry(t, root, "mx_devbox", record(t, root, "section", Complete, map[string]any{"file": "CONTRIBUTING.md", "heading": "Dev container"}))
	edited.Paths = []string{".mex/learned/mx_devbox.md"}
	if r, _ := RunStage(edited); r.Evaluated != 1 || store.rows["mx_devbox"].Verdict != Held {
		t.Fatalf("entry edit: %+v", r)
	}

	// Out of time: the rest keep their cached verdicts and the run says so.
	write(t, root, "package.json", pkg+"\n")
	late := opts
	late.Deadline = time.Now().Add(-time.Second)
	if r, _ := RunStage(late); !r.Unfinished || r.Evaluated != 0 {
		t.Fatalf("deadline: %+v", r)
	}
}

func TestStageBindsTheEntryAndUnrecordedTargetReads(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", pkg)
	c := record(t, root, "key", Complete, map[string]any{"file": "package.json", "pointer": "/scripts/test"})
	c.Files = map[string]string{}
	teamEntry(t, root, "mx_proof00", c)
	report, err := RunStage(StageOptions{Checkout: root, Force: true})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".mex", "learned", "mx_proof00.md"))
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Items) != 1 || report.Items[0].EntryHash != hashBytes(data) {
		t.Fatal("entry bytes were not bound to the evaluated item")
	}
	if len(report.Results) != 1 || report.Results[0].Inputs["package.json"] != hashBytes([]byte(pkg)) {
		t.Fatal("an actual target read was missing from input provenance")
	}
}

// The entry cache: an unchanged, settled entry file is not read again; an
// edited one is, and so is one modified just before the cache was written.
func TestEntryCache(t *testing.T) {
	root, records := t.TempDir(), t.TempDir()
	write(t, root, "package.json", pkg)
	teamEntry(t, root, "mx_script", record(t, root, "key", Complete, map[string]any{"file": "package.json", "pointer": "/scripts/test"}))
	entry := filepath.Join(root, ".mex", "learned", "mx_script.md")
	settled := time.Now().Add(-time.Hour)
	if err := os.Chtimes(entry, settled, settled); err != nil {
		t.Fatal(err)
	}
	store := &memoryStore{rows: map[string]localrecord.Verdict{}}
	opts := StageOptions{Checkout: root, ProjectID: "p1", RecordDirectory: records, Store: store}
	if r, err := RunStage(opts); err != nil || r.Counts[Held] != 1 {
		t.Fatalf("first run: %+v %v", r, err)
	}
	cachePath := EntryCachePath(records, root)
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("no cache written: %v", err)
	}

	// Settled and unchanged: served from the cache, so even an unreadable
	// file would not be read.
	c := openEntryCache(cachePath)
	info, _ := os.Stat(entry)
	if hit, ok := c.old[entry]; !ok || hit.Entry == nil || hit.Entry.ID != "mx_script" || hit.MTime != info.ModTime().UnixNano() {
		t.Fatalf("cache row: %+v", c.old)
	}
	if l := c.read(entry, Team, info); l.Err != nil || l.Entry.ID != "mx_script" || c.dirty {
		t.Fatalf("cached read: %+v dirty=%v", l, c.dirty)
	}

	// An edit changes size or time: the file is read again.
	write(t, root, ".mex/learned/mx_script.md", "not an entry any more")
	if err := os.Chtimes(entry, settled, settled); err != nil {
		t.Fatal(err)
	}
	if r, _ := RunStage(opts); r.Invalid != 1 || r.Entries != 0 {
		t.Fatalf("edited entry: %+v", r)
	}

	// A file modified within the racy window of the cache's write is never
	// trusted, even with the same size and time.
	c = openEntryCache(cachePath)
	info, _ = os.Stat(entry)
	c.written = info.ModTime().UnixNano() + int64(time.Second)
	if l := c.read(entry, Team, info); l.Err == nil || !c.dirty {
		t.Fatalf("racy entry served from the cache: %+v", l)
	}
}
