package delivery

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
)

func (f *fixture) start(source string) string {
	f.t.Helper()
	ev := f.event(contract.SessionStart)
	ev.Source = source
	return f.send(ev)
}

func sqlOpen(f *fixture) (*sql.DB, error) {
	return sql.Open("sqlite", filepath.Join(f.dir, "hooks.db"))
}

func TestRecoveryAfterCompaction(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		for _, order := range []string{"start-first", "post-first"} {
			t.Run(agent+"/"+order, func(t *testing.T) {
				f := newFixture(t)
				f.agent = agent
				f.entry(spec{id: "mx_editpf", kind: "pitfall", scope: "src/edited.ts", oneLine: "Edited file pitfall.", text: "Edited file pitfall, full text with its long reason."})
				f.entry(spec{id: "mx_readpf", kind: "pitfall", scope: "src/read.ts", oneLine: "Read-only file pitfall."})
				f.entry(spec{id: "mx_brokpf", kind: "pitfall", scope: "src/edited.ts", oneLine: "Will break."})
				kind := contract.PostToolBatch
				if agent == "codex" {
					kind = contract.PostTool
				}
				f.start("startup")
				edited := f.file("src/edited.ts", "e")
				for _, tool := range []contract.Tool{read(edited, "e"), read(f.file("src/read.ts", "r"), "r"), edit(edited, "e2")} {
					f.send(f.event(kind, tool))
				}
				f.verdict("mx_brokpf", broken)
				if order == "post-first" && agent == "claude-code" {
					mustBeEmpty(t, f.send(f.event(contract.PostCompact)))
				}
				ctx := f.start("compact")
				mustHave(t, ctx, "MEX notes for the files you were editing:", "Edited file pitfall. (mx_editpf)", "mx_readpf")
				if strings.Contains(ctx, "long reason") || strings.Contains(ctx, "Will break") || strings.Contains(ctx, "Read-only file pitfall") {
					t.Fatalf("recovery carries more than one-liners of edited files: %s", ctx)
				}
				if toks := len(ctx) / 4; toks > 400 {
					t.Fatalf("recovery over budget: %d", toks)
				}
				if order == "start-first" && agent == "claude-code" {
					mustBeEmpty(t, f.send(f.event(contract.PostCompact)))
				}
				// The recovered entry is present in the new epoch; the other
				// comes back at its next moment.
				mustBeEmpty(t, f.send(f.event(kind, read(edited, "e"))))
				mustHave(t, f.send(f.event(kind, read(f.file("src/read.ts", "r"), "r"))), "Read-only file pitfall.")
			})
		}
	}
}

func TestSecondCompactionRecoversAgain(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_editpf", kind: "pitfall", scope: "src/e.ts", oneLine: "Edited file pitfall."})
	f.start("startup")
	p := f.file("src/e.ts", "e")
	f.send(f.event(contract.PostToolBatch, read(p, "e"), edit(p, "x")))
	// Each compaction on Claude Code: PostCompact, then SessionStart compact.
	f.send(f.event(contract.PostCompact))
	mustHave(t, f.start("compact"), "Edited file pitfall.")
	// No edit in the next epoch: the next compaction recovers nothing.
	f.send(f.event(contract.PostCompact))
	mustBeEmpty(t, f.start("compact"))
	// A recovered entry whose file is edited again is recovered again.
	f.send(f.event(contract.PostToolBatch, read(p, "e")))
	f.send(f.event(contract.PostCompact))
	f.start("compact")
	f.send(f.event(contract.PostToolBatch, read(p, "e"), edit(p, "y")))
	f.send(f.event(contract.PostCompact))
	mustHave(t, f.start("compact"), "Edited file pitfall.")
}

func TestResumeCorrections(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_stable", kind: "pitfall", scope: "**", oneLine: "Stable."})
	f.entry(spec{id: "mx_change", kind: "pitfall", scope: "**", oneLine: "Old wording."})
	f.entry(spec{id: "mx_breaks", kind: "pitfall", scope: "**", oneLine: "Breaks later."})
	f.entry(spec{id: "mx_delete", kind: "pitfall", scope: "**", oneLine: "Deleted later."})
	f.start("startup")
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(f.file("a.ts", "a"), "a"))), "Stable.", "Old wording.", "Breaks later.", "Deleted later.")
	mustBeEmpty(t, f.start("resume"))
	f.entry(spec{id: "mx_change", kind: "pitfall", scope: "**", oneLine: "New wording."})
	f.verdict("mx_breaks", broken)
	os.Remove(filepath.Join(filepath.FromSlash(f.root), ".mex", "learned", "mx_delete.md"))
	ctx := f.start("resume")
	mustHave(t, ctx, "Updated: [team, from a person] New wording. (mx_change)", "Correction: the MEX note mx_breaks", "Correction: the MEX note mx_delete")
	if strings.Contains(ctx, "Stable") {
		t.Fatalf("unchanged entry resent on resume: %s", ctx)
	}
	mustBeEmpty(t, f.start("resume"))
}

// transcript writes a Claude Code-shaped JSONL transcript.
func transcript(t *testing.T, path string, lines []map[string]any) {
	t.Helper()
	var b strings.Builder
	for _, l := range lines {
		raw, _ := json.Marshal(l)
		b.Write(raw)
		b.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

func blockOf(t *testing.T, f *fixture, id string) string {
	t.Helper()
	db, _ := sqlOpen(f)
	defer db.Close()
	var block string
	if err := db.QueryRow("SELECT block_id FROM deliveries WHERE entry_id=? AND action='given' ORDER BY rowid DESC LIMIT 1", id).Scan(&block); err != nil {
		t.Fatal(err)
	}
	return block
}

func TestRewindResendsOnlyWhenDropped(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_pitfal", kind: "pitfall", scope: "**", oneLine: "Pitfall."})
	tr := filepath.Join(t.TempDir(), "session.jsonl")
	f.start("startup")
	ev := f.event(contract.PostToolBatch, read(f.file("a.ts", "a"), "a"))
	ev.Transcript = tr
	mustHave(t, f.send(ev), "Pitfall.")
	block := blockOf(t, f, "mx_pitfal")
	marker := "[mex " + block + "]\nPitfall."
	// On the active branch: no resend.
	transcript(t, tr, []map[string]any{
		{"uuid": "u1", "parentUuid": nil, "type": "user"},
		{"uuid": "u2", "parentUuid": "u1", "type": "attachment", "content": marker},
		{"uuid": "u3", "parentUuid": "u2", "type": "assistant"},
	})
	mustBeEmpty(t, f.send(ev))
	// A transcript that never mentions the block: doubt, no resend.
	tr2 := filepath.Join(t.TempDir(), "other.jsonl")
	transcript(t, tr2, []map[string]any{{"uuid": "u1", "parentUuid": nil}})
	ev2 := ev
	ev2.Transcript = tr2
	mustBeEmpty(t, f.send(ev2))
	// Rewind to u1 and continue: the block is now on an abandoned branch.
	w, _ := os.OpenFile(tr, os.O_APPEND|os.O_WRONLY, 0o600)
	fmt.Fprintln(w, `{"uuid":"u4","parentUuid":"u1","type":"user"}`)
	fmt.Fprintln(w, `{"uuid":"u5","parentUuid":"u4","type":"assistant"}`)
	fmt.Fprint(w, `{"uuid":"u6","parentUuid":"u5","type":"assist`) // a line still being written
	w.Close()
	later := time.Now().Add(time.Second)
	os.Chtimes(tr, later, later)
	mustHave(t, f.send(ev), "Pitfall.")
	// Given again; the new block isn't in the transcript yet: doubt.
	mustBeEmpty(t, f.send(ev))
	if got := f.rows("entry_id='mx_pitfal' AND action='given'"); len(got) != 2 {
		t.Fatal(got)
	}
}

func TestSubagentBrief(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_pitfal", kind: "pitfall", scope: "**", oneLine: "Main pitfall.", text: "Main pitfall, with a long reason."})
	f.entry(spec{id: "mx_brokpf", kind: "pitfall", scope: "**", oneLine: "Broken later."})
	f.start("startup")
	f.send(f.event(contract.PostToolBatch, read(f.file("a.ts", "a"), "a")))
	f.verdict("mx_brokpf", broken)
	sub := f.event(contract.SubagentStart)
	sub.AgentID, sub.AgentType = "agent-1", "general-purpose"
	ctx := f.send(sub)
	mustHave(t, ctx, "MEX notes the main session has for this work:", "Main pitfall. (mx_pitfal)")
	if strings.Contains(ctx, "long reason") || strings.Contains(ctx, "Broken later") {
		t.Fatal(ctx)
	}
	// The subagent's own ledger has it: its read stays silent.
	f.agentID = "agent-1"
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(f.file("a.ts", "a"), "a"))))
	// A read-only explorer gets moment items only.
	f.agentID = ""
	sub.AgentID, sub.AgentType = "agent-2", "Explore"
	mustBeEmpty(t, f.send(sub))
	f.agentID = "agent-2"
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(f.file("a.ts", "a"), "a"))), "with a long reason")
	db, _ := sqlOpen(f)
	defer db.Close()
	var budget int
	db.QueryRow("SELECT budget FROM epochs WHERE agent_id='agent-2'").Scan(&budget)
	if budget != 600 {
		t.Fatal(budget)
	}
}
