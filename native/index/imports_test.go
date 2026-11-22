package index

import "testing"

// The same cases as resolveImport's test in src/working-set.
func TestResolveImport(t *testing.T) {
	known := map[string]bool{"src/a.ts": true, "src/lib/index.ts": true, "src/b.js": true}
	cases := []struct{ from, want string }{
		{"./a", "src/a.ts"},
		{"./lib", "src/lib/index.ts"},
		{"./a.js", "src/a.ts"},
		{"./b.js", "src/b.js"},
		{"../../outside", ""},
		{"react", ""},
		{"./missing", ""},
	}
	for _, c := range cases {
		got, ok := resolveImport(c.from, "src/x.ts", known)
		if got != c.want || ok != (c.want != "") {
			t.Errorf("%s: got %q %v, want %q", c.from, got, ok, c.want)
		}
	}
}

func TestResolvesImports(t *testing.T) {
	for lang, want := range map[string]bool{"ts": true, "tsx": true, "js": true, "py": false, "rs": false, "cs": false, "other": false} {
		if resolvesImports(lang) != want {
			t.Errorf("%s: want %v", lang, want)
		}
	}
}
