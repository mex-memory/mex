package brief

import (
	"os"
	"path/filepath"
	"testing"
)

func TestObservedLoadsAreSessionAndCheckoutBound(t *testing.T) {
	opts := setup(t)
	opts.Agent, opts.SessionID, opts.RecordDirectory = "claude-code", "session", t.TempDir()
	text := "<!-- mex:generated -->\n- Small commits. <!-- mx_note01 -->\n"
	put(t, opts.Checkout, "CLAUDE.md", "My rules take precedence over AGENTS.md.")
	put(t, opts.Checkout, "AGENTS.md", text)
	manifest(t, opts.Checkout, ".mex/native.json", "AGENTS.md", text)
	if ReadCoverage(opts).Covers("mx_note01", "claude-code", "main.ts") {
		t.Fatal("predicted a load hidden by CLAUDE.md")
	}
	// Claude can explicitly import this file; InstructionsLoaded is then evidence
	// that overrides the default who-loads-what matrix for this session only.
	ObserveLoaded(opts, filepath.Join(opts.Checkout, "AGENTS.md"))
	if !ReadCoverage(opts).Covers("mx_note01", "claude-code", "main.ts") {
		t.Fatal("didn't observe the actual load")
	}
	other := opts
	other.SessionID = "other"
	if ReadCoverage(other).Covers("mx_note01", "claude-code", "main.ts") {
		t.Fatal("load leaked into another session")
	}
	put(t, opts.Checkout, "AGENTS.md", text+"Edited.")
	if ReadCoverage(opts).Covers("mx_note01", "claude-code", "main.ts") {
		t.Fatal("trusted changed load bytes")
	}
	ObserveLoaded(opts, filepath.Join(t.TempDir(), "AGENTS.md"))
	files, _ := os.ReadDir(filepath.Join(opts.RecordDirectory, "native-coverage"))
	if len(files) != 1 {
		t.Fatalf("unbounded or outside observation: %d", len(files))
	}
}
