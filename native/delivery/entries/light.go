package entries

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/gob"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/record/place"
)

// The light snapshot is what the hook reads on every call that has a moment:
// each entry's id, kind, scope, triggers and recipe commands, without its
// text. It is valid while a listing stamp of the entry stores is unchanged:
// one directory read per folder, using the size and modification time the
// listing already carries. Text and checks are loaded with Load only when a
// moment has found a candidate.

const lightVersion = 1

type lightFile struct {
	Version int    `json:"version"`
	Written int64  `json:"written"`
	Stamp   string `json:"stamp"`
	Items   []Item `json:"items"`
}

func lightPath(directory, project, checkout string) string {
	return filepath.Join(directory, "delivery-entries", place.ShortHash(project+"\n"+checkout)+".light.gob")
}

type storeRoot struct {
	path   string
	nested bool
}

func storeRoots(home, project, checkout string) []storeRoot {
	roots := []storeRoot{{filepath.Join(checkout, ".mex", "learned"), true}}
	if home != "" {
		roots = append(roots, storeRoot{filepath.Join(home, "projects", project, "notes"), false}, storeRoot{filepath.Join(home, "projects", project, "hints"), false})
	}
	return roots
}

// listingStamp hashes every entry file's name, size and modification time,
// and reports the newest modification time. It opens folders only.
func listingStamp(home, project, checkout string) (string, int64, error) {
	h := sha256.New()
	var newest int64
	files := 0
	var walk func(dir string, nested bool, depth int) error
	walk = func(dir string, nested bool, depth int) error {
		f, err := os.Open(dir)
		if errors.Is(err, os.ErrNotExist) {
			_, _ = h.Write([]byte{0})
			return nil
		}
		if err != nil {
			return err
		}
		defer f.Close()
		for {
			list, err := f.ReadDir(256)
			for _, e := range list {
				name := e.Name()
				info, ierr := e.Info()
				if ierr != nil {
					return ierr
				}
				if e.IsDir() {
					if nested && depth == 0 && isKind(name) {
						_, _ = io.WriteString(h, "d:"+name+"\n")
						if err := walk(filepath.Join(dir, name), false, 1); err != nil {
							return err
						}
					}
					continue
				}
				if !strings.HasSuffix(name, ".md") {
					continue
				}
				files++
				if files > maxChildren {
					return errors.New("entry directory scan bound exceeded")
				}
				var b [16]byte
				binary.LittleEndian.PutUint64(b[:8], uint64(info.Size()))
				binary.LittleEndian.PutUint64(b[8:], uint64(info.ModTime().UnixNano()))
				_, _ = io.WriteString(h, name)
				_, _ = h.Write(b[:])
				_, _ = h.Write([]byte{uint8(info.Mode().Type() >> 24)})
				if m := info.ModTime().UnixNano(); m > newest {
					newest = m
				}
			}
			if err == io.EOF || len(list) == 0 {
				return nil
			}
			if err != nil {
				return err
			}
		}
	}
	for _, r := range storeRoots(home, project, checkout) {
		_, _ = io.WriteString(h, "s:"+r.path+"\n")
		if err := walk(r.path, r.nested, 0); err != nil {
			return "", 0, err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), newest, nil
}

// LoadLight returns the light snapshot (Light is true), or the full one when
// the stores changed since the light file was written. Callers that find a
// candidate in a light snapshot call Load for the text.
func LoadLight(directory, home, project, checkout string) (Snapshot, error) {
	if directory == "" || checkout == "" || !validComponent(project) {
		return Snapshot{}, ErrInvalid
	}
	stamp, newest, err := listingStamp(home, project, checkout)
	if err != nil {
		return Snapshot{}, err
	}
	path := lightPath(directory, project, checkout)
	if b, err := readRegular(path, 8*1024*1024); err == nil {
		var lf lightFile
		// A file modified within 2 s of the write may share its timestamp
		// with an edit that came after it: never trust it.
		if gob.NewDecoder(bytes.NewReader(b)).Decode(&lf) == nil && lf.Version == lightVersion && lf.Stamp == stamp && newest < lf.Written-int64(2*time.Second) {
			snap := Snapshot{Light: true, Items: lf.Items}
			for i := range snap.Items {
				it := &snap.Items[i]
				if it.Entry == nil {
					return Load(directory, home, project, checkout)
				}
				for _, scope := range it.Entry.Scope {
					sc, err := newScope(scope)
					if err != nil {
						return Load(directory, home, project, checkout)
					}
					it.Scopes = append(it.Scopes, sc)
				}
			}
			return snap, nil
		}
	}
	full, err := Load(directory, home, project, checkout)
	if err != nil {
		return full, err
	}
	lf := lightFile{Version: lightVersion, Written: time.Now().UnixNano(), Stamp: stamp}
	for _, it := range full.Items {
		lf.Items = append(lf.Items, lighten(it))
	}
	saveGob(path, lf)
	return full, nil
}

// lighten keeps what moments read: no text, and only command checks' targets.
func lighten(it Item) Item {
	e := *it.Entry
	e.Text = ""
	e.Source = Source{Type: e.Source.Type, Ref: e.Source.Ref}
	var checks []Check
	for _, c := range e.Checks {
		if c.Kind == "command" {
			checks = append(checks, Check{Kind: c.Kind, Role: c.Role, Target: c.Target})
		}
	}
	e.Checks = checks
	return Item{Entry: &e, Level: it.Level, Path: it.Path, Hash: it.Hash, Generated: it.Generated, NeedsHintGate: it.NeedsHintGate}
}

func saveGob(path string, v any) {
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(v); err != nil {
		return
	}
	b := buf.Bytes()
	dir := filepath.Dir(path)
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	f, err := os.CreateTemp(dir, ".light-*")
	if err != nil {
		return
	}
	_, werr := f.Write(b)
	cerr := f.Close()
	if werr != nil || cerr != nil || os.Rename(f.Name(), path) != nil {
		_ = os.Remove(f.Name())
	}
}
