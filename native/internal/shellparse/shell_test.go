package shellparse

import (
	"reflect"
	"testing"
)

const root = "/proj"

func r(path string, offset, limit, tail int) Read {
	return Read{Path: Resolve(root, path), Offset: offset, Limit: limit, Tail: tail}
}

func TestSegments(t *testing.T) {
	got := Segments(`cd src && grep -n "a|b" x.ts | head -5; echo 'x;y'`)
	want := []string{"cd src", `grep -n "a|b" x.ts`, "head -5", "echo 'x;y'"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestResolve(t *testing.T) {
	cases := []struct{ cwd, p, want string }{
		{"/proj", "src/a.ts", "/proj/src/a.ts"},
		{"/proj", "../x/./a.ts", "/x/a.ts"},
		{"/proj", "/c/work/a.ts", "c:/work/a.ts"},
		{`C:\proj`, `C:\other\a.ts`, "C:/other/a.ts"},
		{`C:\proj`, `src\a.ts`, "C:/proj/src/a.ts"},
		{"/probe/repo", `/probe/repo\math.js`, "/probe/repo/math.js"},
		{"/proj", "", "/proj"},
	}
	for _, c := range cases {
		if got := Resolve(c.cwd, c.p); got != c.want {
			t.Errorf("Resolve(%q, %q) = %q, want %q", c.cwd, c.p, got, c.want)
		}
	}
}

func TestPosixReads(t *testing.T) {
	cases := []struct {
		cmd     string
		precise bool
		want    []Read
	}{
		{"sed -n 10,20p src/a.ts", false, []Read{r("src/a.ts", 10, 11, 0)}},
		{"head -n 5 src/a.ts", false, []Read{r("src/a.ts", 1, 5, 0)}},
		{"head -3 src/a.ts", false, []Read{r("src/a.ts", 1, 3, 0)}},
		{"tail --lines=4 src/a.ts", false, []Read{r("src/a.ts", 0, 0, 4)}},
		{"cat src/a.ts src/b.ts", false, []Read{r("src/a.ts", 0, 0, 0), r("src/b.ts", 0, 0, 0)}},
		{"cd src; cat a.ts", false, []Read{r("src/a.ts", 0, 0, 0)}},
		{"nl -ba src/a.ts | sed -n 5,9p", true, []Read{r("src/a.ts", 5, 5, 0)}},
		{"cat 'src/a b.ts' | sed -n '3p'", true, []Read{r("src/a b.ts", 3, 1, 0)}},
		{"cat $(ls) ", false, nil},
		{"sed -n 0p a.ts", false, nil},
		{"head -n x a.ts", false, nil},
		{"npm test", false, nil},
	}
	for _, c := range cases {
		got := Reads(c.cmd, root, c.precise)
		if len(got) == 0 && len(c.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: got %+v, want %+v", c.cmd, got, c.want)
		}
	}
}

// The PowerShell cases are the prototype's, with paths now absolute.
func TestPowerShellReads(t *testing.T) {
	cases := []struct {
		cmd  string
		want Read
	}{
		{"Get-Content -Path 'src/core file.ts' -TotalCount 5", r("src/core file.ts", 1, 5, 0)},
		{"gc src/core.ts -Head 3", r("src/core.ts", 1, 3, 0)},
		{"cat -Path src/core.ts -First 4", r("src/core.ts", 1, 4, 0)},
		{"type src/core.ts -Tail 7", r("src/core.ts", 0, 0, 7)},
		{"Get-Content src/core.ts | Select-Object -First 2", r("src/core.ts", 1, 2, 0)},
		{"Get-Content src/core.ts | Select-Object -Last 2", r("src/core.ts", 0, 0, 2)},
		{"(Get-Content 'src/core.ts')[3..8]", r("src/core.ts", 4, 6, 0)},
		{"GET-CONTENT src/core.ts -TotalCount 10 | Select-Object -Last 3", r("src/core.ts", 8, 3, 0)},
		{"cd src; gc core.ts", r("src/core.ts", 0, 0, 0)},
	}
	for _, c := range cases {
		got := Reads(c.cmd, root, false)
		if len(got) != 1 || got[0] != c.want {
			t.Errorf("%q: got %+v, want %+v", c.cmd, got, c.want)
		}
	}
	for _, cmd := range []string{"Get-Content $path", "gc *.ts", "gc x.ts -Tail nope", "(Get-Content x.ts)[8..3]", "gc x.ts -Raw"} {
		if got := Reads(cmd, root, false); len(got) != 0 {
			t.Errorf("%q should abstain, got %+v", cmd, got)
		}
	}
}

func TestSearchPattern(t *testing.T) {
	cases := map[string]string{
		"Select-String -Path src/*.ts -Pattern 'calculateOrderTotal'": "calculateOrderTotal",
		"sls -Pattern 'one|two' -Path src/core.ts":                    "one|two",
		"Get-ChildItem src -Recurse | Select-String -Pattern total":   "total",
		"rg -n --glob '*.ts' applyDiscount src":                       "applyDiscount",
		"cd src && grep -rn -e total .":                               "total",
		"git grep --regexp=foo":                                       "foo",
		"rg -t ts -- -leading":                                        "-leading",
	}
	for cmd, want := range cases {
		if SearchSegment(cmd) == "" {
			t.Errorf("%q: no search segment", cmd)
		}
		if got := SearchPattern(cmd); got != want {
			t.Errorf("%q: pattern %q, want %q", cmd, got, want)
		}
	}
	if SearchPattern("npm test") != "" {
		t.Error("npm test is not a search")
	}
	if got := SearchCwd("cd src && rg x", root); got != Resolve(root, "src") {
		t.Errorf("search cwd = %q", got)
	}
}

func TestOutput(t *testing.T) {
	body := "src/core.ts:2:total\n"
	got, code := Output("Exit code: 0\nWall time: 0.1 seconds\nOutput:\n" + body)
	if got != body || code == nil || *code != 0 {
		t.Errorf("got %q %v", got, code)
	}
	got, code = Output("Exit code: 1\r\nWall time: 2 seconds\r\nOutput:\r\nboom")
	if got != "boom" || code == nil || *code != 1 {
		t.Errorf("got %q %v", got, code)
	}
	got, code = Output(body)
	if got != body || code != nil {
		t.Errorf("plain output changed: %q %v", got, code)
	}
}
