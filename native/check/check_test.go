package check

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, root, path, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func evaluator(t *testing.T, root string) *Evaluator {
	t.Helper()
	ev, err := NewEvaluator(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ev.Close() })
	return ev
}

// record writes a check against today's files, as a writer would.
func record(t *testing.T, root, kind, role string, target map[string]any) Check {
	t.Helper()
	c, err := evaluator(t, root).Record(kind, role, target)
	if err != nil {
		t.Fatalf("record %s: %v", kind, err)
	}
	return c
}

func verdict(t *testing.T, root string, checks ...Check) Result {
	t.Helper()
	return evaluator(t, root).Evaluate(&Entry{ID: "mx_test01", Status: "active", Checks: checks})
}

const pkg = `{
  "name": "demo",
  "scripts": { "test": "tsc && vitest", "lint": "eslint ." },
  "engines": { "node": ">=22" }
}`

func TestKeyCheck(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", pkg)
	c := record(t, root, "key", Complete, map[string]any{"file": "package.json", "pointer": "/scripts/test"})
	if c.Saw["value"] != "tsc && vitest" || !strings.HasPrefix(c.Files["package.json"], "sha256:") {
		t.Fatalf("recorded %+v", c)
	}

	// Reformatting the file changes its hash but not the value: held.
	write(t, root, "package.json", strings.ReplaceAll(pkg, "  ", "    "))
	if r := verdict(t, root, c); r.Verdict != Held || len(r.Checks[0].FilesChanged) != 1 {
		t.Fatalf("reformatted: %+v", r)
	}
	// A real change to a complete check: broken.
	write(t, root, "package.json", strings.ReplaceAll(pkg, "tsc && vitest", "vitest"))
	if r := verdict(t, root, c); r.Verdict != Broken || r.Checks[0].Status != Fail || r.Checks[0].Now != "vitest" {
		t.Fatalf("changed: %+v", r)
	}
	// The same change to a supporting check only sends it to the judge.
	c.Role = Supporting
	if r := verdict(t, root, c); r.Verdict != Changed {
		t.Fatalf("supporting: %+v", r)
	}
	// The key removed: gone.
	c.Role = Complete
	write(t, root, "package.json", `{"scripts":{}}`)
	if r := verdict(t, root, c); r.Verdict != Broken || r.Checks[0].Status != Gone {
		t.Fatalf("removed: %+v", r)
	}
}

func TestKeyCheckJSONCAndYAML(t *testing.T) {
	root := t.TempDir()
	write(t, root, "tsconfig.json", "{\n  // strict on\n  \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\", },\n}\n")
	write(t, root, ".github/workflows/ci.yml", "jobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n")
	strict := record(t, root, "key", Complete, map[string]any{"file": "tsconfig.json", "pointer": "/compilerOptions/strict"})
	timeout := record(t, root, "key", Complete, map[string]any{"file": ".github/workflows/ci.yml", "pointer": "/jobs/test/timeout-minutes"})
	// Values read back from an entry file are ints, not float64.
	timeout.Saw["value"] = 15
	if r := verdict(t, root, strict, timeout); r.Verdict != Held {
		t.Fatalf("held: %+v", r)
	}
	write(t, root, ".github/workflows/ci.yml", "jobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n")
	if r := verdict(t, root, strict, timeout); r.Verdict != Broken {
		t.Fatalf("broken: %+v", r)
	}
}

func TestCommandCheck(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", pkg)
	write(t, root, "Makefile", "VERSION := 1\n.PHONY: build test\nbuild: deps\n\tgo build ./...\ntest:\n\tgo test ./...\n")
	script := record(t, root, "command", Complete, map[string]any{"run": "npm run lint", "file": "package.json", "pointer": "/scripts/lint"})
	target := record(t, root, "command", Complete, map[string]any{"run": "make build", "file": "Makefile", "pointer": "/build"})
	if r := verdict(t, root, script, target); r.Verdict != Held {
		t.Fatalf("held: %+v", r)
	}
	if _, err := evaluator(t, root).Record("command", Complete, map[string]any{"run": "make VERSION", "file": "Makefile", "pointer": "/VERSION"}); !errors.Is(err, ErrNotRecordable) {
		t.Fatalf("a variable is not a target: %v", err)
	}
	write(t, root, "package.json", `{"scripts":{"test":"vitest"}}`)
	write(t, root, "Makefile", "compile:\n\tgo build ./...\n")
	r := verdict(t, root, script, target)
	if r.Verdict != Broken || r.Checks[0].Status != Gone || r.Checks[1].Status != Gone {
		t.Fatalf("gone: %+v", r)
	}
}

const contributing = `# Contributing

Intro text.

## Dev container

Open the repo in the dev container.
It has Node 22 and Go installed.

### Extensions

The recommended extensions load automatically.

## Releases

Maintainers cut releases.
`

func TestSectionCheck(t *testing.T) {
	root := t.TempDir()
	write(t, root, "CONTRIBUTING.md", contributing)
	c := record(t, root, "section", Complete, map[string]any{"file": "CONTRIBUTING.md", "heading": "Dev container"})

	// Re-wrapping and editing another section: held.
	reflowed := strings.Replace(contributing, "dev container.\nIt has", "dev container. It\nhas", 1)
	reflowed = strings.Replace(reflowed, "Maintainers cut releases.", "Only maintainers cut releases.", 1)
	write(t, root, "CONTRIBUTING.md", strings.ReplaceAll(reflowed, "\n", "\r\n"))
	if r := verdict(t, root, c); r.Verdict != Held {
		t.Fatalf("reflowed: %+v", r)
	}
	// Editing a subsection is editing the section.
	write(t, root, "CONTRIBUTING.md", strings.Replace(contributing, "load automatically", "must be installed by hand", 1))
	if r := verdict(t, root, c); r.Verdict != Broken || r.Checks[0].Status != Fail {
		t.Fatalf("edited: %+v", r)
	}
	// A heading inside a code fence doesn't count; the real one is gone.
	write(t, root, "CONTRIBUTING.md", "# Contributing\n\n```md\n## Dev container\n```\n")
	if r := verdict(t, root, c); r.Checks[0].Status != Gone {
		t.Fatalf("fenced: %+v", r)
	}
}

func TestSetextSection(t *testing.T) {
	data := []byte("Setup\n=====\n\nRun it.\n\nUsage\n-----\nCall it.\n\nOther\n=====\n")
	body, ok := section(data, "Usage")
	if !ok || strings.TrimSpace(body) != "Call it." {
		t.Fatalf("usage: %q %v", body, ok)
	}
	body, ok = section(data, "Setup")
	if !ok || !strings.Contains(body, "Run it.") || !strings.Contains(body, "Call it.") {
		t.Fatalf("setup holds its subsection: %q", body)
	}
}

func TestSourceCheck(t *testing.T) {
	root := t.TempDir()
	write(t, root, "docs/review-4412.md", "Never call the payments API from a hook.\n")
	file := record(t, root, "source", Supporting, map[string]any{"file": "docs/review-4412.md"})
	write(t, root, "docs/review-4412.md", "Never call the payments API\nfrom a hook.\n\n")
	if r := verdict(t, root, file); r.Verdict != Held {
		t.Fatalf("whitespace: %+v", r)
	}
	write(t, root, "docs/review-4412.md", "Call the payments API from a hook if you must.\n")
	if r := verdict(t, root, file); r.Verdict != Changed {
		t.Fatalf("edited supporting source: %+v", r)
	}
}

func TestFloor(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/cors.ts", "export const defaults = { allowMethods: ['GET'] }\n")
	url := Check{Kind: "source", Role: Complete, Target: map[string]any{"url": "https://example.com/pr/1"}, Saw: map[string]any{"hash": "sha256:x"}}
	if r := verdict(t, root, url); r.Verdict != Unknown || r.Checks[0].Status != Floor {
		t.Fatalf("a URL with no files is unknown: %+v", r)
	}

	hash := hashBytes([]byte("export const defaults = { allowMethods: ['GET'] }\n"))
	value := Check{Kind: "relation", Role: Complete, Target: map[string]any{}, Saw: map[string]any{}, Files: map[string]string{"src/cors.ts": hash}}
	if r := verdict(t, root, value); r.Verdict != Held || r.Inputs["src/cors.ts"] != hash {
		t.Fatalf("unchanged floor: %+v", r)
	}
	write(t, root, "src/cors.ts", "export const defaults = { allowMethods: ['GET', 'POST'] }\n")
	if r := verdict(t, root, value); r.Verdict != Changed || r.Checks[0].FilesChanged[0] != "src/cors.ts" {
		t.Fatalf("changed floor never says held: %+v", r)
	}
	if err := os.Remove(filepath.Join(root, "src", "cors.ts")); err != nil {
		t.Fatal(err)
	}
	if r := verdict(t, root, value); r.Verdict != Changed || r.Inputs["src/cors.ts"] != "missing" {
		t.Fatalf("missing floor: %+v", r)
	}
}

func TestVerdictOrder(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", pkg)
	ok := record(t, root, "key", Complete, map[string]any{"file": "package.json", "pointer": "/name"})
	if r := evaluator(t, root).Evaluate(&Entry{ID: "mx_none01", Status: "active"}); r.Verdict != Unknown {
		t.Fatalf("no checks: %+v", r)
	}
	if r := evaluator(t, root).Evaluate(&Entry{ID: "mx_gone01", Status: "retired", Checks: []Check{ok}}); r.Verdict != Broken {
		t.Fatalf("retired: %+v", r)
	}
	bad := ok
	bad.Saw = map[string]any{"value": "other"}
	bad.Role = Supporting
	if r := verdict(t, root, ok, bad); r.Verdict != Changed {
		t.Fatalf("one supporting failure: %+v", r)
	}
}

func TestReadsStayInTheCheckout(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "repo")
	write(t, parent, "secret.json", `{"token":"x"}`)
	write(t, root, "package.json", pkg)
	ev := evaluator(t, root)
	for _, file := range []string{"../secret.json", "/etc/passwd", "C:/x.json", "a/../../secret.json"} {
		if _, err := ev.Record("key", Complete, map[string]any{"file": file, "pointer": "/token"}); err == nil {
			t.Fatalf("%s was read", file)
		}
	}
	if err := os.Symlink(filepath.Join(parent, "secret.json"), filepath.Join(root, "link.json")); err == nil {
		if _, err := ev.Record("key", Complete, map[string]any{"file": "link.json", "pointer": "/token"}); err == nil {
			t.Fatal("a link out of the checkout was followed")
		}
	}
}

func TestRecordRefusesWhatDoesNotPass(t *testing.T) {
	root := t.TempDir()
	write(t, root, "README.md", "# Demo\n")
	ev := evaluator(t, root)
	cases := []struct {
		kind   string
		target map[string]any
	}{
		{"key", map[string]any{"file": "missing.json", "pointer": "/a"}},
		{"command", map[string]any{"run": "npm test", "file": "package.json", "pointer": "/scripts/test"}},
		{"section", map[string]any{"file": "README.md", "heading": "Install"}},
		{"source", map[string]any{"url": "https://example.com"}},
		{"value", map[string]any{"file": "README.md", "symbol": "x"}},
		{"relation", map[string]any{"query": "imports", "from": "a/**", "to": "b/**"}},
	}
	for _, c := range cases {
		if _, err := ev.Record(c.kind, Complete, c.target); !errors.Is(err, ErrNotRecordable) {
			t.Fatalf("%s %v: %v", c.kind, c.target, err)
		}
	}
	if _, err := ev.Record("section", "strong", map[string]any{"file": "README.md", "heading": "Demo"}); err == nil {
		t.Fatal("unknown role accepted")
	}
}

func TestDatesReadAsText(t *testing.T) {
	root := t.TempDir()
	write(t, root, "release.yml", "released: 2026-11-14\n")
	c := record(t, root, "key", Complete, map[string]any{"file": "release.yml", "pointer": "/released"})
	if c.Saw["value"] != "2026-11-14" {
		t.Fatalf("saw %#v", c.Saw["value"])
	}
	e, err := ParseEntry([]byte(strings.Replace(entryFile, `saw: {value: "tsc && vitest"}`, "saw: {value: 2026-11-14}", 1)))
	if err != nil || !equalValues(e.Checks[0].Saw["value"], "2026-11-14") {
		t.Fatalf("entry date: %v %#v", err, e)
	}
}
