package delivery

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

func TestCompactionKeepsWholePathsAndIDs(t *testing.T) {
	items := []keepItem{
		{"Edited file", "Makefile", true},
		{"Edited file", "src/compat.ts", true},
		{"Delivered entry ID", "mx_widget", true},
		{"User constraint", "Preserve protocol version 42", false},
	}
	missing, score := compareCompaction("Edited Makefile and src/compat.test.ts. Gave mx_widget_test. Preserve protocol version 43.", items)
	if !score.Estimated || score.Checked != 4 || score.Kept != 1 || len(missing) != 3 {
		t.Fatalf("score=%+v, missing=%+v", score, missing)
	}
}

func TestCompactionAllowsProseParaphrase(t *testing.T) {
	items := []keepItem{{"User constraint", "Preserve backward compatibility for registry imports.", false}}
	missing, score := compareCompaction("Maintain backward compatibility for registry imports.", items)
	if score.Checked != 1 || score.Kept != 1 || len(missing) != 0 {
		t.Fatalf("score=%+v, missing=%+v", score, missing)
	}
	missing, score = compareCompaction("Imports are available.", items)
	if score.Kept != 0 || len(missing) != 1 {
		t.Fatalf("weak overlap was accepted: score=%+v, missing=%+v", score, missing)
	}
}

func TestCompactionRecoveryIsBounded(t *testing.T) {
	f := newFixture(t)
	items := []keepItem{{"Last user request", "Preserve public API compatibility.", false}}
	for range 64 {
		items = append(items, keepItem{"Earlier user message", strings.Repeat("check one more path ", 38), false})
	}
	text := compactionBlock(f.event(contract.PostCompact), 1, items)
	mustHave(t, text, "Preserve public API compatibility.")
	if count := entries.EstimateTokens(text); count > checkedRecoveryBudget {
		t.Fatalf("recovery uses %d estimated tokens", count)
	}
}

func TestCompactionReservesRoomForDeliveredNotes(t *testing.T) {
	for _, late := range []bool{false, true} {
		t.Run(fmt.Sprintf("late=%t", late), func(t *testing.T) {
			f := newFixture(t)
			f.entry(spec{id: "mx_editpf", kind: "pitfall", scope: "src/edited.ts", oneLine: "Keep the edited file portable."})
			f.start("startup")
			file := f.file("src/edited.ts", "old")
			f.send(f.event(contract.PostToolBatch, read(file, "old"), edit(file, "new")))
			post := f.event(contract.PostCompact)
			var notes string
			if late {
				notes = f.start("compact")
			}
			mustBeEmpty(t, f.send(post))
			items := []keepItem{{"Last user request", "Maintain the stable endpoint.", false}}
			for range 20 {
				items = append(items, keepItem{"User constraint", strings.Repeat("Preserve old client compatibility. ", 5), false})
			}
			block := compactionBlock(post, 1, items)
			if err := capture.StageCompactionRecovery(post, capture.Env{RecordDirectory: f.dir, Now: f.now}, 1, block); err != nil {
				t.Fatal(err)
			}
			if late {
				prompt := f.event(contract.Prompt)
				prompt.Prompt = &contract.PromptIn{Text: "Continue", Typed: true}
				notes += "\n\n" + f.send(prompt)
			} else {
				notes = f.start("compact")
			}
			mustHave(t, notes, "Keep the edited file portable. (mx_editpf)", "Maintain the stable endpoint.")
			if count := entries.EstimateTokens(notes); count > recoveryBudget {
				t.Fatalf("both recovery blocks use %d estimated tokens", count)
			}
		})
	}
}

func TestCompactionUsesFilteredQuotesAndHandlesLateSummary(t *testing.T) {
	f := newFixture(t)
	f.start("startup")
	f.now = f.now.Add(time.Second)
	promptAt := f.now.UTC().Format(time.RFC3339Nano)
	hooks, err := record.OpenHooks(record.Location{Directory: f.dir, Hooks: filepath.Join(f.dir, "hooks.db")})
	if err != nil {
		t.Fatal(err)
	}
	session := record.Session{SessionID: f.session, Agent: f.agent, ProjectID: f.project, Checkout: f.root}
	err = hooks.AppendJournal(session, promptAt, []record.JournalRow{
		{Kind: "typed", Text: "Decide between SQLite and flat files."},
		{Kind: "typed", Text: "Keep the old endpoint. The rest of this message is just background."},
		{Kind: "typed", Text: "That earlier tangent was about cafeteria hours."},
		{Kind: "typed", Text: "Check whether the failover worker restarts."},
		{Kind: "typed", Text: "Finish the registry migration."},
	})
	if err == nil {
		err = hooks.PruneJournal(f.project, 1)
	}
	hooks.Close()
	if err != nil {
		t.Fatal(err)
	}

	db, err := sql.Open("sqlite", filepath.Join(f.dir, "record.db"))
	if err != nil {
		t.Fatal(err)
	}
	const batch = `{"version":1,"phase":"complete","candidates":[
		{"kind":"rule","label":"lasting","quote":"Keep the old endpoint.","text":"Generated alternate.",
		 "source":{"session":"s1","row":2,"at":%s,"marks":""}},
		{"kind":"decision","label":"next-session","quote":"Decide between SQLite and flat files.",
		 "source":{"session":"s1","row":1,"at":%s,"marks":""}},
		{"kind":"rule","label":"lasting","quote":"Other session input.",
		 "source":{"session":"s2","row":4,"at":%s,"marks":""}}]}`
	_, err = db.Exec(`CREATE TABLE settings(scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope,key))`)
	if err == nil {
		stamp := strconv.Quote(promptAt)
		_, err = db.Exec("INSERT INTO settings VALUES(?, ?, ?)", f.project, "filter.batch.test", fmt.Sprintf(batch, stamp, stamp, stamp))
	}
	if err == nil {
		_, err = db.Exec("INSERT INTO settings VALUES(?, ?, '3')", f.project, "filter.session."+record.ShortHash(f.session))
	}
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(time.Second)
	mustBeEmpty(t, f.start("compact"))
	post := f.event(contract.PostCompact)
	post.Summary = "Finish the registry migration."
	mustBeEmpty(t, f.send(post))
	prompt := f.event(contract.Prompt)
	prompt.Prompt = &contract.PromptIn{Text: "Continue", Typed: true}
	out := f.send(prompt)
	mustHave(t, out, "User constraint or correction", "Keep the old endpoint.", "Decide between SQLite and flat files.",
		"Check whether the failover worker restarts.")
	for _, excluded := range []string{"cafeteria hours", "just background", "Generated alternate", "Other session input"} {
		if strings.Contains(out, excluded) {
			t.Fatalf("unexpected %q in %s", excluded, out)
		}
	}
	mustBeEmpty(t, f.send(prompt))
	hookSQL, err := sqlOpen(f)
	if err != nil {
		t.Fatal(err)
	}
	defer hookSQL.Close()
	var detail string
	err = hookSQL.QueryRow("SELECT detail FROM deliveries WHERE moment='compaction-check'").Scan(&detail)
	if err != nil || detail != `{"kept":1,"checked":4,"estimated":true}` {
		t.Fatalf("compaction estimate %q, %v", detail, err)
	}
}
