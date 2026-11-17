package index

import (
	"testing"
)

// The same cases as src/file-index/__tests__/parse-and-glob.test.ts.
func TestGlobDialect(t *testing.T) {
	cases := []struct {
		glob, path string
		want       bool
	}{
		{"apps/api/**", "apps/api/src/a.ts", true},
		{"apps/api/**", "apps/api", true},
		{"apps/api/**", "apps/apix/a.ts", false},
		{"apps/api/", "apps/api/a.ts", true},
		{"**/*.ts", "a.ts", true},
		{"**/*.ts", "a/b/c.ts", true},
		{"**/*.ts", "a/b/c.tsx", false},
		{"*.md", "README.md", true},
		{"*.md", "docs/a.md", false},
		{"src/**/test/*.py", "src/test/a.py", true},
		{"src/**/test/*.py", "src/x/y/test/a.py", true},
		{"src/**/**/a.ts", "src/a.ts", true},
		{"apps/{api,web}/**", "apps/web/x.ts", true},
		{"apps/{api,web}/**", "apps/worker/x.ts", false},
		{"a?.ts", "ab.ts", true},
		{"a?.ts", "a/.ts", false},
		{"file(1).ts", "file(1).ts", true},
		{"**", "anything/at/all", true},
		{"", "x", true},
		{"./src/*.ts", "src/a.ts", true},
	}
	for _, c := range cases {
		re, err := globRegexp(c.glob)
		if err != nil {
			t.Fatalf("%s: %v", c.glob, err)
		}
		if got := re.MatchString(c.path); got != c.want {
			t.Errorf("%q against %q: got %v want %v", c.glob, c.path, got, c.want)
		}
	}
	for glob, want := range map[string]string{"apps/api/**": "apps/api/", "**/*.ts": "", "src/{a,b}/x": "src/", "README.md": "README.md"} {
		if got := globPrefix(glob); got != want {
			t.Errorf("prefix %q: got %q want %q", glob, got, want)
		}
	}
}
