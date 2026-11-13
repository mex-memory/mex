package shellparse

import (
	"reflect"
	"strings"
	"testing"
)

func patch(body string) string { return "*** Begin Patch\n" + body + "\n*** End Patch" }

func TestParsePatchAllOperations(t *testing.T) {
	for _, eol := range []string{"\n", "\r\n"} {
		body := patch("*** Update File: /proj/src/old name.ts\n*** Move to: src/new name.ts\n@@\n-old\n+new\n*** Add File: src/added.ts\n+hello\n*** Delete File: src/deleted.ts")
		got := ParsePatch(strings.ReplaceAll(body, "\n", eol), root)
		if len(got) != 3 {
			t.Fatalf("eol %q: %d files", eol, len(got))
		}
		want := []struct {
			path, move string
			kind       PatchKind
		}{
			{Resolve(root, "src/old name.ts"), Resolve(root, "src/new name.ts"), PatchUpdate},
			{Resolve(root, "src/added.ts"), "", PatchAdd},
			{Resolve(root, "src/deleted.ts"), "", PatchDelete},
		}
		for i, w := range want {
			if got[i].Path != w.path || got[i].MoveTo != w.move || got[i].Kind != w.kind {
				t.Errorf("file %d = %+v, want %+v", i, got[i], w)
			}
		}
		if !reflect.DeepEqual(got[0].Chunks, []PatchChunk{{Before: []string{"old"}, After: []string{"new"}}}) {
			t.Errorf("chunks = %+v", got[0].Chunks)
		}
		if !reflect.DeepEqual(got[1].Chunks, []PatchChunk{{After: []string{"hello"}}}) {
			t.Errorf("add chunks = %+v", got[1].Chunks)
		}
		files := PatchedFiles(got)
		if len(files) != 4 {
			t.Errorf("patched files = %q", files)
		}
	}
}

func TestParsePatchResolvesAgainstCwd(t *testing.T) {
	got := ParsePatch(patch("*** Update File: core.ts\n@@\n-a\n+b"), Resolve(root, "src"))
	if len(got) != 1 || got[0].Path != Resolve(root, "src/core.ts") {
		t.Fatalf("got %+v", got)
	}
}

func TestParsePatchContext(t *testing.T) {
	got := ParsePatch(patch("*** Update File: a.ts\n@@ function add\n keep\n-old\n+new\n*** End of File"), root)
	want := []PatchChunk{{Before: []string{"keep", "old"}, After: []string{"keep", "new"}}}
	if len(got) != 1 || !reflect.DeepEqual(got[0].Chunks, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestParsePatchRejects(t *testing.T) {
	cases := map[string]string{
		"unterminated":   "*** Begin Patch\n*** Delete File: a.ts",
		"too many files": patch(strings.Repeat("*** Delete File: a.ts\n", maxPatchFiles+1)),
		"oversized":      patch("*** Add File: a.ts\n+" + strings.Repeat("x", maxPatchBytes)),
		"line before @@": patch("*** Update File: a.ts\n-a"),
		"unknown line":   patch("*** Update File: a.ts\n@@\n?what"),
		"not a patch":    "echo hi",
	}
	for name, body := range cases {
		if got := ParsePatch(body, root); got != nil {
			t.Errorf("%s: got %+v", name, got)
		}
	}
}

// The Codex probe recorded a Windows path with mixed separators.
func TestParsePatchMixedSeparators(t *testing.T) {
	got := ParsePatch(patch(`*** Update File: /probe/repo\math.js`+"\n@@\n-a\n+b"), "/probe/repo")
	if len(got) != 1 || !strings.HasSuffix(strings.ReplaceAll(got[0].Path, `\`, "/"), "math.js") {
		t.Fatalf("got %+v", got)
	}
}
