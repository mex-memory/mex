package entries

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func BenchmarkLoad500(b *testing.B)  { benchLoad(b, Load) }
func BenchmarkLight500(b *testing.B) { benchLoad(b, LoadLight) }
func benchLoad(b *testing.B, load func(string, string, string, string) (Snapshot, error)) {
	root, home, dir := b.TempDir(), b.TempDir(), b.TempDir()
	learned := filepath.Join(root, ".mex", "learned")
	os.MkdirAll(learned, 0o700)
	for i := 0; i < 500; i++ {
		id := fmt.Sprintf("mx_t%05d", i)
		body := fmt.Sprintf("---\nmex:\n  id: %s\n  kind: pitfall\n  scope:\n    - \"src/hit%d.ts\"\n  source:\n    type: docs\n    ref: CONTRIBUTING.md\n  evidence: docs\n  one_line: \"Pitfall %d for its file.\"\n  checks: []\n  status: active\n  created: 2026-11-03\n---\nPitfall %d.\n", id, i, i, i)
		p := filepath.Join(learned, id+".md")
		os.WriteFile(p, []byte(body), 0o600)
		past := time.Now().Add(-5 * time.Second)
		os.Chtimes(p, past, past)
	}
	if _, err := load(dir, home, "project", root); err != nil {
		b.Fatal(err)
	}
	s, _ := load(dir, home, "project", root)
	b.Logf("parsed=%d reused=%d items=%d", s.Parsed, s.Reused, len(s.Items))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := load(dir, home, "project", root); err != nil {
			b.Fatal(err)
		}
	}
}
