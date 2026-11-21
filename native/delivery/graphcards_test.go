package delivery

import (
	"reflect"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/graph"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestChangedDeclarations(t *testing.T) {
	cases := []struct {
		name     string
		old, new string
		want     map[string]string
	}{
		{"typescript parameter added",
			"export function area(radius: number): number {\n  return 1;\n}",
			"export function area(radius: number, scale: number): number {\n  return 1;\n}",
			map[string]string{"area": "export function area(radius: number, scale: number): number {"}},
		{"an arrow function bound to a const",
			"export const splitPath = (path: string): string[] => {",
			"export const splitPath = (path: string, sep = '/'): string[] => {",
			map[string]string{"splitPath": "export const splitPath = (path: string, sep = '/'): string[] => {"}},
		{"a method",
			"  async request(input: string, init?: RequestInit) {",
			"  async request(input: string | URL, init?: RequestInit) {",
			map[string]string{"request": "async request(input: string | URL, init?: RequestInit) {"}},
		{"body only: no change",
			"export function area(radius: number): number {\n  return 1;\n}",
			"export function area(radius: number): number {\n  return 2;\n}",
			map[string]string{}},
		{"whitespace only: no change",
			"def load(path, mode):\n    pass",
			"def load(path,  mode):\n    pass",
			map[string]string{}},
		{"python and go",
			"def load(path):\n    pass\nfunc (s *Store) Get(key string) string {",
			"def load(path, mode):\n    pass\nfunc (s *Store) Get(key string, def string) string {",
			map[string]string{"load": "def load(path, mode):", "Get": "func (s *Store) Get(key string, def string) string {"}},
		{"a renamed function is not a changed signature",
			"function oldName(a) {", "function newName(a, b) {", map[string]string{}},
		{"calls and control flow are not declarations",
			"  if (ready(x)) {\n  return area(1);\n  doThing(a)\n  } else if (x) {",
			"  if (ready(x, y)) {\n  return area(1, 2);\n  doThing(a, b)\n  } else if (x, y) {",
			map[string]string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := changedDeclarations(c.old, c.new)
			if len(got) == 0 && len(c.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("changedDeclarations = %#v, want %#v", got, c.want)
			}
		})
	}
}

func TestPatchText(t *testing.T) {
	removed, added := patchText(`{"type":"update","structuredPatch":[{"oldStart":3,"lines":[" a","-export function f(x) {","+export function f(x, y) {"," b"]}]}`)
	if removed != "export function f(x) {\n" || added != "export function f(x, y) {\n" {
		t.Fatalf("removed %q added %q", removed, added)
	}
	if r, a := patchText("File created successfully"); r != "" || a != "" {
		t.Fatal("text without a patch read as one")
	}
}

func TestSearchShows(t *testing.T) {
	shown := searchShows("src/a.ts:12:  const parts = splitPath(path)\nsrc/b.ts-3-other")
	if !shown("const parts = splitPath(path)") || shown("let x = splitPath('/')") || shown("short") {
		t.Fatal("search output lines not told apart")
	}
}

func TestGraphCardsStaySilentWithoutAMoment(t *testing.T) {
	env := Environment{RecordDirectory: t.TempDir()}
	for _, ev := range []contract.Event{
		{Kind: contract.SessionStart, ProjectID: "g-000000000000000000000000", Checkout: t.TempDir()},
		{Kind: contract.Prompt, ProjectID: "g-000000000000000000000000", Checkout: t.TempDir()},
		{Kind: contract.PostTool, Checkout: t.TempDir()},
	} {
		if cards := graphCards(ev, env); len(cards) != 0 {
			t.Fatalf("%s: got %d cards, want none", ev.Kind, len(cards))
		}
	}
}

// outlineFiles answers the outline headerChanges reads.
type outlineFiles struct{ symbols []shift.Symbol }

func (o outlineFiles) Outline(path string) (*index.OutlineAnswer, *index.Miss) {
	return &index.OutlineAnswer{Path: path, Symbols: o.symbols}, nil
}
func (o outlineFiles) FileInfo(path string) (*index.FileInfoAnswer, *index.Miss) {
	return &index.FileInfoAnswer{Path: path}, nil
}

// An edit to a multi-line signature's parameters names no declaration: the
// definition whose header holds it is found, with its header as one line.
func TestHeaderChangesFindsMultiLineSignatures(t *testing.T) {
	text := []string{
		"export async function resolveDomainName({",
		"  domainRepository,",
		"  domain,",
		"  scope,",
		"}: {",
		"  domainRepository: DomainRepository;",
		"  domain: string;",
		"  scope: { environmentId: string; organizationId: string };",
		"}): Promise<DomainEntity> {",
		"  const name = domain.toLowerCase();",
		"  return name;",
		"}",
	}
	view := graph.View{
		Files: outlineFiles{[]shift.Symbol{{Name: "resolveDomainName", Kind: "function", Start: 1, End: 12}}},
		Src:   func(string) []string { return text },
	}
	got := headerChanges(view, "a.ts", "  domain,\n  scope,\n")
	if len(got) != 1 || got[0].def.Name != "resolveDomainName" || !strings.HasPrefix(got[0].header, "export async function resolveDomainName({ domainRepository, domain, scope, }") {
		t.Fatalf("parameter edit: %v", got)
	}
	crlf := view
	crlf.Src = func(string) []string { return strings.Split(strings.Join(text, "\r\n"), "\n") }
	if hits := headerChanges(crlf, "a.ts", "  domain,\r\n  scope,\r\n"); !reflect.DeepEqual(hits, got) {
		t.Fatalf("CRLF parameter edit: %v, want %v", hits, got)
	}
	// An edit in the body is not a signature change.
	if got := headerChanges(view, "a.ts", "  const name = domain.toLowerCase();\n"); len(got) != 0 {
		t.Fatalf("body edit: %v", got)
	}
	// Text that is in more than one place can't be placed.
	if got := headerChanges(view, "a.ts", "  domainRepository,"); len(got) != 1 {
		t.Fatalf("unique line: %v", got)
	}
	if got := headerChanges(view, "a.ts", "}"); len(got) != 0 {
		t.Fatalf("ambiguous: %v", got)
	}
}
