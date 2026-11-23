package delivery

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
	"path/filepath"
)

func TestSuppressedLearnedBumpDeliversScopedProse(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_review1", kind: "rule", scope: "src/**", source: "review", evidence: "review",
		producer: "learn-deeper", oneLine: "Use the stable accessor.", when: []string{"anti:oldAccessor()"}, level: "personal"})
	f.verdict("mx_review1", held)
	f.start("startup")
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "record.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE settings (scope TEXT,key TEXT,value TEXT); INSERT INTO settings VALUES ('project','learning.noise.mx_review1','{"stops":20,"ignored":3,"at":"2026-11-23T00:00:00Z"}')`)
	if err != nil {
		t.Fatal(err)
	}
	call := edited(f, "src/example.ts", "", "oldAccessor()")
	if reply := preEdit(f, call); reply.Decision != "" {
		t.Fatalf("suppressed rule stopped an edit: %+v", reply)
	}
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(f.file("src/example.ts", ""), ""))), "Use the stable accessor.")
	if _, err := db.Exec("DELETE FROM settings"); err != nil {
		t.Fatal(err)
	}
	if reply := preEdit(f, call); reply.Decision != contract.Deny {
		t.Fatalf("restored rule did not stop the edit: %+v", reply)
	}
}

func TestLearnedBumpShowsFixAndRecordsTheOverride(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_review1", kind: "rule", scope: "src/**", source: "review", evidence: "review",
		producer: "learn-deeper", label: "from 2 PRs, 3 maintainers", oneLine: "Use the stable accessor.",
		when: []string{"anti:oldAccessor()"}, fix: "  const value = stableAccessor()\n  return value", level: "personal"})
	f.verdict("mx_review1", held)
	f.start("startup")
	call := edited(f, "src/example.ts", "", "oldAccessor()")
	reply := preEdit(f, call)
	if reply.Decision != contract.Deny {
		t.Fatalf("first edit was not stopped: %+v", reply)
	}
	mustHave(t, reply.Reason, "Do this instead (from `src/example.ts`):", "```\n  const value = stableAccessor()\n  return value\n```",
		"Learned from 2 PR reviews · `mex recall mx_review1`")
	if reply := preEdit(f, call); reply.Decision != "" {
		t.Fatalf("the same edit was stopped again: %+v", reply)
	}
	got := f.rows("entry_id='mx_review1' AND moment='bump'")
	if len(got) != 2 || !strings.Contains(got[0], ":given:bump:") || !strings.Contains(got[1], ":control:bump:") {
		t.Fatal(got)
	}
	t.Log(reply.Reason)
}

func TestLearnedBumpTrimsWholeLinesAcrossThreeReasons(t *testing.T) {
	f := newFixture(t)
	var patterns, firstLines, lastLines []string
	for i := 1; i <= 3; i++ {
		id := fmt.Sprintf("mx_review%d", i)
		pattern := fmt.Sprintf("oldAccessor%d()", i)
		first := fmt.Sprintf("%d%s", i, strings.Repeat("\u754c", 120))
		last := fmt.Sprintf("omitted-%d%s", i, strings.Repeat("\u754c", 600))
		f.entry(spec{id: id, kind: "rule", scope: "src/**", source: "review", evidence: "review",
			producer: "learn-deeper", label: "Learned from 3 reviews", oneLine: "Replace " + pattern,
			when: []string{"anti:" + pattern}, text: strings.Repeat("Long reason. ", 600), fix: first + "\n" + last})
		f.verdict(id, held)
		patterns, firstLines, lastLines = append(patterns, pattern), append(firstLines, first), append(lastLines, last)
	}
	f.start("startup")
	call := edited(f, "src/example.ts", "", strings.Join(patterns, "\n"))
	reply := preEdit(f, call)
	if reply.Decision != contract.Deny || len(reply.Reason) > bumpReplyBytes || !utf8.ValidString(reply.Reason) ||
		strings.Count(reply.Reason, "(trimmed)") != 3 {
		t.Fatalf("reply has %d bytes and %d trim notices: %.200s", len(reply.Reason), strings.Count(reply.Reason, "(trimmed)"), reply.Reason)
	}
	for i, first := range firstLines {
		mustHave(t, reply.Reason, "```\n"+first+"\n```", patterns[i])
		if strings.Contains(reply.Reason, lastLines[i][:9]) {
			t.Fatal("a partial code line was shown")
		}
	}
	if reply := preEdit(f, call); reply.Decision != "" {
		t.Fatal("the same edit did not pass")
	}
}

func TestLearnedAnchorTouchAtEitherLevel(t *testing.T) {
	for _, level := range []string{"personal", "team"} {
		for _, kind := range []string{"rule", "decision", "pitfall", "procedure"} {
			for _, tool := range []string{"read", "edit"} {
				t.Run(level+"/"+kind+"/"+tool, func(t *testing.T) {
					f := newFixture(t)
					f.entry(spec{id: "mx_review1", level: level, kind: kind, scope: "src/**", producer: "learn-deeper",
						source: "review", evidence: "review", oneLine: "Keep one canonical key."})
					f.verdict("mx_review1", held)
					f.start("startup")
					touch := func(rel string) string {
						p := f.file(rel, "export {}")
						call := read(p, "")
						if tool == "edit" {
							call = edit(p, "export const key = 1")
						}
						return f.send(f.event(contract.PostToolBatch, call))
					}
					mustBeEmpty(t, touch("outside/key.ts"))
					mustHave(t, touch("src/key.ts"), "Keep one canonical key.", "mx_review1")
					mustBeEmpty(t, touch("src/another.ts"))
					if got := f.rows("entry_id='mx_review1' AND action='given'"); len(got) != 1 || !strings.Contains(got[0], ":anchor-touch:") {
						t.Fatal(got)
					}
				})
			}
		}
	}
}

func TestLearnedAnchorTouchRecognizesOnlyLoadedRuleFile(t *testing.T) {
	for _, scope := range []string{"src/**", "other/**"} {
		t.Run(scope, func(t *testing.T) {
			f := newFixture(t)
			f.entry(spec{id: "mx_review1", kind: "decision", scope: "src/**", producer: "learn-deeper",
				source: "review", evidence: "review", oneLine: "Keep one canonical key."})
			f.verdict("mx_review1", held)
			f.file(".claude/rules/keys.md", "---\npaths:\n  - "+scope+"\n---\nKeep one canonical key. <!-- mex:mx_review1 -->\n")
			f.start("startup")
			got := f.send(f.event(contract.PostToolBatch, read(f.file("src/key.ts", ""), "")))
			if scope == "src/**" {
				mustBeEmpty(t, got)
				if rows := f.rows("entry_id='mx_review1' AND moment='rule-file' AND action='given'"); len(rows) != 1 {
					t.Fatal(rows)
				}
			} else {
				mustHave(t, got, "Keep one canonical key.")
			}
		})
	}
}

func TestLearnedEntriesStayOutOfSubagentAndRecoveryBriefs(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_review1", level: "personal", kind: "rule", producer: "learn-deeper",
		source: "review", evidence: "review", oneLine: "Learned personal process."})
	f.entry(spec{id: "mx_deepteam", kind: "rule", source: "review", evidence: "review", oneLine: "Learned team process."})
	f.entry(spec{id: "mx_person1", level: "personal", kind: "rule", oneLine: "Person's note."})
	f.start("startup")
	h, err := record.OpenHooks(record.Location{Directory: f.dir, Hooks: filepath.Join(f.dir, "hooks.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	ev := f.event(contract.SessionStart)
	req := baseRequest(ev, f.env(), f.project, f.root)
	for _, id := range []string{"mx_review1", "mx_deepteam", "mx_person1"} {
		req.Candidates = append(req.Candidates, record.DeliveryCandidate{
			EntryID: id, Moment: "anchor-touch", Form: "one-line", Action: "given", Exempt: true,
		})
	}
	if _, err := h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	sub := f.event(contract.SubagentStart)
	sub.AgentID, sub.AgentType = "editor", "general-purpose"
	got := f.send(sub)
	mustHave(t, got, "Person's note.")
	if strings.Contains(got, "Learned") || strings.Contains(got, "mx_review1") || strings.Contains(got, "mx_deepteam") {
		t.Fatal(got)
	}
	got = f.start("compact")
	if strings.Contains(got, "Learned") || strings.Contains(got, "mx_review1") || strings.Contains(got, "mx_deepteam") {
		t.Fatal(got)
	}
}
