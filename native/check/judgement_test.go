package check

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/judgement"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

func TestModelHoldCacheExpiresDuringPartialAndDeadlineStages(t *testing.T) {
	root, directory := t.TempDir(), t.TempDir()
	write(t, root, ".git/HEAD", "ref: refs/heads/work\n")
	write(t, root, ".git/refs/heads/work", strings.Repeat("a", 40)+"\n")
	write(t, root, "api.ts", "export const timeout = 30; // old\n")
	c := record(t, root, "source", Supporting, map[string]any{"file": "api.ts"})
	teamEntry(t, root, "mx_proof00", c)
	write(t, root, "api.ts", "export const timeout = 30; // judged\n")
	write(t, root, "other.ts", "an extra file the model saw\n")
	store := &memoryStore{rows: map[string]localrecord.Verdict{}}
	db, err := sql.Open("sqlite", filepath.Join(directory, "record.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE settings(scope TEXT,key TEXT,value TEXT,PRIMARY KEY(scope,key)); CREATE TABLE judgements(project_id TEXT,entry_id TEXT,inputs_hash TEXT,result TEXT,at TEXT,PRIMARY KEY(project_id,entry_id,inputs_hash)); PRAGMA user_version=5`); err != nil {
		t.Fatal(err)
	}
	opts := StageOptions{Checkout: root, ProjectID: "p1", RecordDirectory: directory, Store: store}
	initial, err := RunStage(opts)
	if err != nil || initial.Counts[Changed] != 1 {
		t.Fatalf("initial: %+v %v", initial, err)
	}
	base := initial.Results[0].EvaluationHash
	entryHash := initial.Items[0].EntryHash
	key := "judge." + place.ShortHash(root) + ".mx_proof00"
	parts := []string{"model-judgement-v1", root, "mx_proof00", entryHash, base, hashBytes([]byte("observations")), "fixture", "refs/heads/work", strings.Repeat("a", 40)}
	var files []map[string]any
	for _, path := range []string{"api.ts", "other.ts"} {
		data, _ := os.ReadFile(filepath.Join(root, path))
		h := hashBytes(data)
		files = append(files, map[string]any{"path": path, "hash": h})
		parts = append(parts, path, h)
	}
	var identity strings.Builder
	for _, s := range parts {
		identity.WriteString(strconv.Itoa(len(s)))
		identity.WriteByte(':')
		identity.WriteString(s)
	}
	inputHash := hashBytes([]byte(identity.String()))
	p := map[string]any{"version": 1, "id": "mx_proof00", "checkout": root, "position": map[string]any{"branch": "refs/heads/work", "head": strings.Repeat("a", 40)}, "entry_hash": entryHash, "evaluation_hash": base, "inputs_hash": inputHash, "checks_hash": hashBytes([]byte("observations")), "result": "still-true", "label": "checked by model", "model": "fixture", "at": time.Now().UTC().Format(time.RFC3339Nano), "files": files}
	raw, _ := json.Marshal(p)
	if _, err = db.Exec("INSERT INTO judgements VALUES('p1','mx_proof00',?,'still-true','now')", inputHash); err != nil {
		t.Fatal(err)
	}
	put := func() {
		t.Helper()
		if _, err := db.Exec("INSERT OR REPLACE INTO settings VALUES('p1',?,?)", key, string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	put()
	if r, err := RunStage(opts); err != nil || r.Counts[Held] != 1 || r.Items[0].Label != "checked by model" {
		t.Fatalf("held: %+v %v", r, err)
	}
	if r, err := RunStage(opts); err != nil || r.Reused != 1 || r.Items[0].Label != "checked by model" {
		t.Fatalf("cache: %+v %v", r, err)
	}
	partial := opts
	partial.Paths = []string{"unrelated.ts"}
	if _, err = db.Exec("DELETE FROM settings WHERE key=?", key); err != nil {
		t.Fatal(err)
	}
	if r, err := RunStage(partial); err != nil || r.Counts[Changed] != 1 {
		t.Fatalf("withdrawn proof survived partial scan: %+v %v", r, err)
	}
	put()
	RunStage(opts)
	partial.Paths = []string{"other.ts"}
	write(t, root, "other.ts", "the extra evidence changed\n")
	if r, err := RunStage(partial); err != nil || r.Counts[Changed] != 1 {
		t.Fatalf("extra input change survived: %+v %v", r, err)
	}
	write(t, root, "other.ts", "an extra file the model saw\n")
	RunStage(opts)
	late := opts
	late.Deadline = time.Now().Add(-time.Second)
	if r, err := RunStage(late); err != nil || !r.Unfinished || r.Counts[Unknown] != 1 || store.rows["mx_proof00"].Verdict != Unknown {
		t.Fatalf("deadline retained a model hold: %+v %v", r, err)
	}
	RunStage(opts)
	// A matching journal row alone cannot rebind altered cached evidence.
	p["evaluation_hash"] = hashBytes([]byte("other evaluation"))
	bad, _ := json.Marshal(p)
	db.Exec("UPDATE settings SET value=? WHERE key=?", string(bad), key)
	if r, err := RunStage(opts); err != nil || r.Counts[Changed] != 1 {
		t.Fatalf("unsealed alteration held: %+v %v", r, err)
	}
}

func TestPersonalLearnedRuleCanHoldByJudgement(t *testing.T) {
	root, directory, home := t.TempDir(), t.TempDir(), t.TempDir()
	id := "mx_deep" + strings.Repeat("a", 32)
	head := strings.Repeat("a", 40)
	write(t, root, ".git/HEAD", "ref: refs/heads/work\n")
	write(t, root, ".git/refs/heads/work", head+"\n")
	write(t, root, "api.ts", "export const timeout = 30; // old\n")
	c := record(t, root, "source", Supporting, map[string]any{"file": "api.ts"})
	write(t, home, "projects/p1/notes/"+id+".md", "---\nmex:\n  id: "+id+"\n  kind: rule\n  status: active\n"+
		"  source: {type: docs, producer: learn-deeper}\n  checks:\n  - kind: source\n    role: supporting\n    target: {file: api.ts}\n"+
		"    saw: {hash: "+str(c.Saw, "hash")+"}\n    files: {api.ts: "+c.Files["api.ts"]+"}\n---\nUse the default timeout.\n")
	current := "export const timeout = 30; // judged\n"
	write(t, root, "api.ts", current)
	db, err := sql.Open("sqlite", filepath.Join(directory, "record.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE settings(scope TEXT,key TEXT,value TEXT,PRIMARY KEY(scope,key)); CREATE TABLE judgements(project_id TEXT,entry_id TEXT,inputs_hash TEXT,result TEXT,at TEXT,PRIMARY KEY(project_id,entry_id,inputs_hash)); PRAGMA user_version=5`); err != nil {
		t.Fatal(err)
	}
	opts := StageOptions{Checkout: root, ProjectID: "p1", MexHome: home, RecordDirectory: directory}
	initial, err := RunStage(opts)
	if err != nil || initial.Counts[Changed] != 1 {
		t.Fatalf("changed: %+v %v", initial, err)
	}
	entryHash, evalHash := initial.Items[0].EntryHash, initial.Results[0].EvaluationHash
	checksHash, fileHash := hashBytes([]byte("observations")), hashBytes([]byte(current))
	parts := []string{"model-judgement-v1", root, id, entryHash, evalHash, checksHash, "fixture", "refs/heads/work", head, "api.ts", fileHash}
	var identity strings.Builder
	for _, s := range parts {
		identity.WriteString(strconv.Itoa(len(s)) + ":" + s)
	}
	inputHash := hashBytes([]byte(identity.String()))
	p := map[string]any{"version": 1, "id": id, "checkout": root, "position": map[string]string{"branch": "refs/heads/work", "head": head},
		"entry_hash": entryHash, "evaluation_hash": evalHash, "inputs_hash": inputHash, "checks_hash": checksHash, "result": "still-true",
		"label": "checked by model", "model": "fixture", "at": time.Now().UTC().Format(time.RFC3339Nano), "files": []map[string]string{{"path": "api.ts", "hash": fileHash}}}
	raw, _ := json.Marshal(p)
	if _, err = db.Exec("INSERT INTO judgements VALUES('p1',?,?,'still-true','now')", id, inputHash); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO settings VALUES('p1',?,?)", "judge."+place.ShortHash(root)+"."+id, string(raw)); err != nil {
		t.Fatal(err)
	}
	if r, err := RunStage(opts); err != nil || r.Counts[Held] != 1 || r.Items[0].Label != "checked by model" {
		t.Fatalf("held: %+v %v", r, err)
	}
	write(t, root, "api.ts", "export const timeout = 60;\n")
	if r, err := RunStage(opts); err != nil || r.Counts[Changed] != 1 {
		t.Fatalf("a changed input kept the hold: %+v %v", r, err)
	}
}

func TestModelHoldCannotOverrideNativeRejectionOrTeamOnly(t *testing.T) {
	for _, mode := range []string{"complete", "gone", "unreadable", "team-only"} {
		t.Run(mode, func(t *testing.T) {
			root, directory := t.TempDir(), t.TempDir()
			write(t, root, ".git/HEAD", "ref: refs/heads/work\n")
			write(t, root, ".git/refs/heads/work", strings.Repeat("a", 40)+"\n")
			write(t, root, "api.ts", "export const timeout = 30; // old\n")
			role := Supporting
			if mode == "complete" {
				role = Complete
			}
			c := record(t, root, "source", role, map[string]any{"file": "api.ts"})
			teamEntry(t, root, "mx_proof00", c)
			write(t, root, "api.ts", "export const timeout = 30; // changed\n")
			if mode == "gone" {
				if err := os.Remove(filepath.Join(root, "api.ts")); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "unreadable" {
				if err := os.Remove(filepath.Join(root, "api.ts")); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(root, "api.ts"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			write(t, root, "other.ts", "readable evidence\n")
			store := &memoryStore{rows: map[string]localrecord.Verdict{}}
			opts := StageOptions{Checkout: root, ProjectID: "p1", RecordDirectory: directory, Store: store}
			initial, err := RunStage(opts)
			if err != nil || len(initial.Results) != 1 {
				t.Fatalf("initial: %+v %v", initial, err)
			}
			base, entryHash := initial.Results[0].EvaluationHash, initial.Items[0].EntryHash
			fileHash := hashBytes([]byte("readable evidence\n"))
			parts := []string{"model-judgement-v1", root, "mx_proof00", entryHash, base, hashBytes([]byte("observations")), "fixture", "refs/heads/work", strings.Repeat("a", 40), "other.ts", fileHash}
			var identity strings.Builder
			for _, s := range parts {
				identity.WriteString(strconv.Itoa(len(s)))
				identity.WriteByte(':')
				identity.WriteString(s)
			}
			inputHash := hashBytes([]byte(identity.String()))
			p := map[string]any{"version": 1, "id": "mx_proof00", "checkout": root, "position": map[string]any{"branch": "refs/heads/work", "head": strings.Repeat("a", 40)}, "entry_hash": entryHash, "evaluation_hash": base, "inputs_hash": inputHash, "checks_hash": hashBytes([]byte("observations")), "result": "still-true", "label": "checked by model", "model": "fixture", "at": time.Now().UTC().Format(time.RFC3339Nano), "files": []map[string]string{{"path": "other.ts", "hash": fileHash}}}
			raw, _ := json.Marshal(p)
			db, err := sql.Open("sqlite", filepath.Join(directory, "record.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err = db.Exec(`CREATE TABLE settings(scope TEXT,key TEXT,value TEXT,PRIMARY KEY(scope,key)); CREATE TABLE judgements(project_id TEXT,entry_id TEXT,inputs_hash TEXT,result TEXT,at TEXT,PRIMARY KEY(project_id,entry_id,inputs_hash)); PRAGMA user_version=5`); err != nil {
				t.Fatal(err)
			}
			if _, err = db.Exec("INSERT INTO judgements VALUES('p1','mx_proof00',?,'still-true','now')", inputHash); err != nil {
				t.Fatal(err)
			}
			if _, err = db.Exec("INSERT INTO settings VALUES('p1',?,?)", "judge."+place.ShortHash(root)+".mx_proof00", string(raw)); err != nil {
				t.Fatal(err)
			}
			reader := judgement.Open(directory, "p1", root)
			_, valid := reader.CacheKey("mx_proof00", entryHash, base)
			reader.Close()
			if !valid {
				t.Fatal("fixture attestation must be valid before checking native guard")
			}
			if mode == "team-only" {
				opts.TeamOnly = true
			}
			r, err := RunStage(opts)
			if err != nil || r.Items[0].Verdict == Held || r.Items[0].Label != "" {
				t.Fatalf("native guard bypassed: %+v %v", r, err)
			}
		})
	}
}
