package check

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const entryFile = `---
mex:
  id: mx_7f3k2a
  kind: fact
  scope: ["package.json"]
  source:
    type: config
    ref: package.json
  evidence: mined
  one_line: "The test script type-checks, then runs vitest."
  checks:
    - kind: key
      role: complete
      target: {file: package.json, pointer: /scripts/test}
      saw: {value: "tsc && vitest"}
      files: {package.json: "sha256:0000000000000000000000000000000000000000000000000000000000000000"}
  status: active
  created: 2026-11-14
---
The test script type-checks first, so type errors fail the run.
`

func TestParseEntry(t *testing.T) {
	e, err := ParseEntry([]byte(strings.ReplaceAll(entryFile, "\n", "\r\n")))
	if err != nil {
		t.Fatal(err)
	}
	if e.ID != "mx_7f3k2a" || len(e.Checks) != 1 || e.Checks[0].Target["pointer"] != "/scripts/test" || e.Checks[0].Saw["value"] != "tsc && vitest" {
		t.Fatalf("parsed %+v", e)
	}
	bad := map[string]string{
		"alias":         strings.Replace(entryFile, "scope: [\"package.json\"]", "scope: &s [\"package.json\"]\n  extra: *s", 1),
		"duplicate key": strings.Replace(entryFile, "kind: fact", "kind: fact\n  kind: rule", 1),
		"custom tag":    strings.Replace(entryFile, "evidence: mined", "evidence: !!binary bWluZWQ=", 1),
		"bad role":      strings.Replace(entryFile, "role: complete", "role: strong", 1),
		"bad hash":      strings.Replace(entryFile, "sha256:0000", "md5:0000", 1),
		"escaping file": strings.Replace(entryFile, "files: {package.json:", "files: {../package.json:", 1),
		"bad id":        strings.Replace(entryFile, "mx_7f3k2a", "MX_1", 1),
		"no block":      "just text\n",
	}
	for name, content := range bad {
		if _, err := ParseEntry([]byte(content)); !errors.Is(err, ErrInvalidEntry) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestLoadAll(t *testing.T) {
	checkout, home := t.TempDir(), t.TempDir()
	write(t, checkout, ".mex/learned/mx_7f3k2a.md", entryFile)
	write(t, checkout, ".mex/learned/rules/mx_aaaaaa.md", strings.ReplaceAll(entryFile, "mx_7f3k2a", "mx_aaaaaa"))
	write(t, checkout, ".mex/learned/rules/deeper/mx_bbbbbb.md", strings.ReplaceAll(entryFile, "mx_7f3k2a", "mx_bbbbbb"))
	write(t, checkout, ".mex/learned/mx_cccccc.md", entryFile) // name doesn't match id
	write(t, checkout, ".mex/learned/.entry-1.tmp", entryFile)
	write(t, home, "projects/p1/notes/mx_dddddd.md", strings.ReplaceAll(entryFile, "mx_7f3k2a", "mx_dddddd"))
	write(t, home, "projects/p1/hints/mx_eeeeee.md", strings.ReplaceAll(entryFile, "mx_7f3k2a", "mx_eeeeee"))
	write(t, home, "projects/p2/notes/mx_ffffff.md", strings.ReplaceAll(entryFile, "mx_7f3k2a", "mx_ffffff"))
	_ = os.Symlink(filepath.Join(checkout, ".mex/learned/mx_7f3k2a.md"), filepath.Join(checkout, ".mex/learned/mx_gggggg.md"))

	all, err := LoadAll(checkout, home, "p1")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, l := range all {
		if l.Err != nil {
			got[filepath.Base(l.Path)] = "error"
			continue
		}
		got[l.Entry.ID] = l.Level
	}
	want := map[string]string{"mx_7f3k2a": Team, "mx_aaaaaa": Team, "mx_cccccc.md": "error", "mx_dddddd": Personal, "mx_eeeeee": Hint}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if none, err := LoadAll(t.TempDir(), home, "missing"); err != nil || len(none) != 0 {
		t.Fatalf("empty: %v %v", none, err)
	}
}
