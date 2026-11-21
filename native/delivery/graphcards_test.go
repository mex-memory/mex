package delivery

import (
	"reflect"
	"testing"

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
