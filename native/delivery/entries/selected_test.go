package entries

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSelectedRequiresCurrentCanonicalBytes(t *testing.T) {
	root, home, dir := t.TempDir(), t.TempDir(), t.TempDir()
	store := filepath.Join(root, ".mex", "learned")
	os.MkdirAll(store, 0700)
	file := filepath.Join(store, "mx_abcdef.md")
	content := fixtures(t)[0].Content
	os.WriteFile(file, []byte(content), 0600)
	snap, err := Load(dir, home, "project", root)
	if err != nil || len(snap.Items) != 1 {
		t.Fatal(snap, err)
	}
	selected, err := Selected(home, "project", root, snap, map[string]bool{"mx_abcdef": true})
	if err != nil || len(selected.Items) != 1 || selected.Items[0].Full != snap.Items[0].Full {
		t.Fatal(selected, err)
	}
	os.WriteFile(file, []byte(replaceText(content, "Updated current claim.")), 0600)
	if _, err = Selected(home, "project", root, snap, map[string]bool{"mx_abcdef": true}); err == nil {
		t.Fatal("stale entry accepted")
	}
	outside := filepath.Join(t.TempDir(), "mx_abcdef.md")
	os.WriteFile(outside, []byte(content), 0600)
	snap.Items[0].Path = outside
	if _, err = Selected(home, "project", root, snap, map[string]bool{"mx_abcdef": true}); err == nil {
		t.Fatal("cache path escaped canonical store")
	}
}
