package sqliteuri

import "testing"

func TestImmutablePreservesWindowsPaths(t *testing.T) {
	for _, test := range []struct {
		name, path, uri string
	}{
		{"drive", `C:\Graph store\base#1.db`, "file:C:%5CGraph%20store%5Cbase%231.db"},
		{"verbatim drive", `\\?\C:\Graph store\base#1.db`, "file:%5C%5C%3F%5CC:%5CGraph%20store%5Cbase%231.db"},
		{"UNC", `\\server\share\base%.db`, "file:%5C%5Cserver%5Cshare%5Cbase%25.db"},
		{"verbatim UNC", `\\?\UNC\server\share\base.db`, "file:%5C%5C%3F%5CUNC%5Cserver%5Cshare%5Cbase.db"},
		{"slash UNC", "//server/share/base.db", "file:////server/share/base.db"},
	} {
		t.Run(test.name, func(t *testing.T) {
			want := test.uri + "?mode=ro&immutable=1"
			if got := Immutable(test.path); got != want {
				t.Fatalf("Immutable(%q) = %q, want %q", test.path, got, want)
			}
		})
	}
}
