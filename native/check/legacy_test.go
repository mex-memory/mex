package check

import (
	"errors"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
)

const legacyEntry = `---
mex:
  id: mx_legacy1
  kind: fact
  scope: ["**"]
  source: {type: docs, ref: .mex/context/api.md}
  evidence: docs
  one_line: The old claim remains unverified.
  status: active
  created: 2026-11-15
  checks:
    - kind: legacy-grounding
      role: supporting
      target: {node: "function:12345678abcdefab", file: src/api.ts}
      saw: {fingerprint: "mh2:64:Original_CASE", bodyHash: old-body, codeHash: old-code}
      files: {}
---
The old claim remains unverified.
`

func TestLegacyGroundingNeverRenewsItsBaseline(t *testing.T) {
	e, err := ParseEntry([]byte(legacyEntry))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for _, content := range []string{"", "export function api() { return 1 }", "export function api() { return 2 }"} {
		if content != "" {
			write(t, root, "src/api.ts", content)
		}
		r := evaluator(t, root).Evaluate(e)
		if r.Verdict != Unknown || r.Checks[0].Status != Floor || r.Checks[0].Reason != "legacy grounding needs review" || len(r.Inputs) != 0 || r.Checks[0].Now != nil {
			t.Fatalf("baseline renewed or code read: %+v", r)
		}
	}
	if e.Checks[0].Saw["fingerprint"] != "mh2:64:Original_CASE" || e.Checks[0].Saw["bodyHash"] != "old-body" {
		t.Fatalf("baseline changed: %+v", e.Checks)
	}
	if _, err := evaluator(t, root).Record("legacy-grounding", Supporting, e.Checks[0].Target); !errors.Is(err, ErrNotRecordable) {
		t.Fatalf("legacy evidence can be renewed: %v", err)
	}
	passing := record(t, root, "source", Complete, map[string]any{"file": "src/api.ts"})
	if r := verdict(t, root, e.Checks[0], passing); r.Verdict != Unknown {
		t.Fatalf("passing check masks legacy evidence: %+v", r)
	}
	write(t, root, "src/api.ts", "changed")
	if r := verdict(t, root, e.Checks[0], passing); r.Verdict != Broken {
		t.Fatalf("legacy evidence masks a worse verdict: %+v", r)
	}
}

func TestLegacyGroundingRejectsCertificationAndMalformedEvidence(t *testing.T) {
	for _, invalid := range []string{
		strings.Replace(legacyEntry, "role: supporting", "role: complete", 1),
		strings.Replace(legacyEntry, "files: {}", "files: {src/api.ts: 'sha256:"+strings.Repeat("a", 64)+"'}", 1),
		strings.Replace(legacyEntry, "function:12345678abcdefab", "api", 1),
		strings.Replace(legacyEntry, "mh2:64:Original_CASE", "today", 1),
		strings.Replace(legacyEntry, "file: src/api.ts", "file: ../api.ts", 1),
		strings.Replace(legacyEntry, "bodyHash: old-body", "bodyHash: old-body, renewed: true", 1),
	} {
		if _, err := ParseEntry([]byte(invalid)); err == nil {
			t.Fatal("evaluator accepted malformed legacy evidence")
		}
		if _, err := entries.Parse([]byte(invalid)); err == nil {
			t.Fatal("delivery accepted malformed legacy evidence")
		}
	}
}
