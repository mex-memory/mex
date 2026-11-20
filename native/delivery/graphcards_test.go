package delivery

import (
	"reflect"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
)

func TestChangedSignatures(t *testing.T) {
	cases := []struct {
		name     string
		old, new string
		want     map[string]string
	}{
		{"typescript parameter added",
			"export function area(radius: number): number {\n  return 1;\n}",
			"export function area(radius: number, scale: number): number {\n  return 1;\n}",
			map[string]string{"area": "export function area(radius: number, scale: number): number"}},
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
			map[string]string{"load": "def load(path, mode):", "Get": "func (s *Store) Get(key string, def string) string"}},
		{"a renamed function is not a changed signature",
			"function oldName(a) {", "function newName(a, b) {", map[string]string{}},
		{"calls and control flow are not declarations",
			"  if (ready(x)) {\n  return area(1);", "  if (ready(x, y)) {\n  return area(1, 2);", map[string]string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := changedSignatures(c.old, c.new)
			if len(got) == 0 && len(c.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("changedSignatures = %#v, want %#v", got, c.want)
			}
		})
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
