package delivery

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

func TestSurfaceSettingsAndShadowRender(t *testing.T) {
	env := Environment{Home: t.TempDir(), RecordDirectory: t.TempDir()}
	for _, id := range record.SurfaceIDs() {
		if got := surfaceSetting(env, "p", id); got != record.SurfaceDefault(id) {
			t.Fatal(id, got)
		}
	}
	if err := os.WriteFile(filepath.Join(env.Home, "controls.json"), []byte(`{"version":1,"surfaces":{"read-pitfall":"shadow","edit":"off"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got := surfaceSetting(env, "p", "read-pitfall"); got != "shadow" {
		t.Fatal(got)
	}
	if err := os.MkdirAll(filepath.Join(env.RecordDirectory, "hook-delivery"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env.RecordDirectory, "hook-delivery", "p.json"), []byte(`{"version":1,"surfaces":{"read-pitfall":"off"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got := surfaceSetting(env, "p", "read-pitfall"); got != "off" {
		t.Fatal(got)
	}
	env.Surfaces = `{"read-pitfall":"on"}`
	if got := surfaceSetting(env, "p", "read-pitfall"); got != "on" {
		t.Fatal(got)
	}
	f := newFixture(t)
	f.entry(spec{id: "mx_pitfal", kind: "pitfall", scope: "src/**", oneLine: "The pool belongs to the process."})
	p := f.file("src/a.ts", "pool\n")
	env = f.env()
	env.Surfaces = "shadow"
	reply, err := Handle(f.event(contract.PostToolBatch, read(p, "pool")), env)
	if err != nil || !reply.Empty() {
		t.Fatal(reply, err)
	}
	if got := f.rows(""); len(got) != 1 || got[0] != "mx_pitfal:shadow:read:full" {
		t.Fatal(got)
	}
	// A later edit with no new moment must still settle the original window.
	reply, err = Handle(f.event(contract.PostToolBatch, edit(p, "safe()")), env)
	if err != nil || !reply.Empty() {
		t.Fatal(reply, err)
	}
	reply, err = Handle(f.event(contract.SessionEnd), env)
	if err != nil || !reply.Empty() {
		t.Fatal(reply, err)
	}
	report, err := record.ReadSurfaces(filepath.Join(f.dir, "hooks.db"), f.project, f.root)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range report.Surfaces {
		if s.Surface == "read-pitfall" && (s.Shadow.Firings != 1 || s.Shadow.Settled != 1) {
			t.Fatal(s)
		}
	}
}

func TestSurfaceToolCountUsesOriginalBatch(t *testing.T) {
	f := newFixture(t)
	p := f.file("src/a.ts", "x")
	tools := surfaceTools(f.event(contract.PostToolBatch, read(p, "x"), shell("cat src/a.ts", "x", true)), f.env())
	if len(tools) != 2 || !tools[0].Open || !tools[1].Open {
		t.Fatal(tools)
	}
	if got := surfaceTools(f.event(contract.PostTool, read(p, "x")), f.env()); len(got) != 0 {
		t.Fatal("counted per-tool success plus batch", got)
	}
}

func TestCallsWithoutDeliveryAreLoggedThenSettledInOrder(t *testing.T) {
	f := newFixture(t)
	f.setIntent("working")
	f.entry(spec{id: "mx_rulelg", kind: "rule", scope: "apps/api/**", oneLine: "Log through src/logger, not console.log.", when: []string{"anti:console.log("}})
	p := f.file("apps/api/a.ts", "console.log(1)\n")
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(p, "1\tconsole.log(1)"))), "Log through src/logger")
	db := func(q string) int {
		t.Helper()
		conn, err := sql.Open("sqlite", filepath.Join(f.dir, "hooks.db"))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		var n int
		if err = conn.QueryRow(q).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Unrelated reads deliver nothing: they are logged, not settled.
	for i := 0; i < 3; i++ {
		mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(f.file("docs/x"+string(rune('a'+i))+".md", "x"), "x"))))
	}
	if n := db(`SELECT count(*) FROM surface_windows WHERE settled=1`); n != 0 {
		t.Fatal("calls that delivered nothing opened a transaction", n)
	}
	matches, _ := filepath.Glob(filepath.Join(f.dir, "surface-pending", "*", "observed"))
	if len(matches) != 1 {
		t.Fatal("no observation log", matches)
	}
	// An edit in the rule's scope is a moment of its own: its transaction
	// settles the logged reads first, then the edit, which avoids the literal.
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, edit(p, "logger.info(1)"))))
	if matches, _ = filepath.Glob(filepath.Join(f.dir, "surface-pending", "*", "observed")); len(matches) != 0 {
		t.Fatal("the log wasn't claimed", matches)
	}
	f.send(f.event(contract.SessionEnd))
	if n := db(`SELECT count(*) FROM surface_windows WHERE settled=1 AND acted=1`); n != 1 {
		t.Fatal("the logged edit wasn't settled as acted", n)
	}
	if n := db(`SELECT tool_calls FROM epochs ORDER BY epoch DESC LIMIT 1`); n < 4 {
		t.Fatal("logged calls weren't counted", n)
	}
}

// The agent never saw a shadow receipt, so its entry turning broken has
// nothing to correct: no correction, only the log row.
func TestShadowReceiptGetsNoCorrection(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_pitfal", kind: "pitfall", scope: "src/**", oneLine: "The pool is shared."})
	p := f.file("src/a.ts", "a")
	env := f.env()
	env.Surfaces = "shadow"
	reply, err := Handle(f.event(contract.PostToolBatch, read(p, "a")), env)
	if err != nil || !reply.Empty() {
		t.Fatal(reply, err)
	}
	f.verdict("mx_pitfal", broken)
	q := f.file("src/b.ts", "b")
	reply, err = Handle(f.event(contract.PostToolBatch, read(q, "b")), f.env())
	if err != nil || strings.Contains(reply.Context, "Correction:") {
		t.Fatal(reply, err)
	}
	for _, row := range f.rows("") {
		if strings.Contains(row, ":correction:") {
			t.Fatal("a shadow receipt drew a correction:", f.rows(""))
		}
	}
}
