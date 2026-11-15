package delivery

import (
	"os"
	"path/filepath"
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
