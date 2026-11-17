package noteguard

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPublicationFence(t *testing.T) {
	parent := t.TempDir()
	notes := filepath.Join(parent, "notes")
	check, err := Begin(notes)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parent, "notes.pending"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Begin(notes); err == nil {
		t.Fatal("read during pending swap")
	}
	if err := check(); err == nil {
		t.Fatal("missed pending swap")
	}
	if err := os.WriteFile(filepath.Join(parent, "notes.revision"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(parent, "notes.pending")); err != nil {
		t.Fatal(err)
	}
	if err := check(); err == nil {
		t.Fatal("missed completed swap or rollback")
	}
	fresh, err := Begin(notes)
	if err != nil {
		t.Fatal(err)
	}
	if err := fresh(); err != nil {
		t.Fatal(err)
	}
}
func TestRevisionRefusesRedirects(t *testing.T) {
	parent := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(parent, "notes.revision")); err != nil {
		t.Skip(err)
	}
	if _, err := Begin(filepath.Join(parent, "notes")); err == nil {
		t.Fatal("followed a revision symlink")
	}
}
