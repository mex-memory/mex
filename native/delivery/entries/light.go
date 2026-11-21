package entries

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"github.com/mex-memory/mex/native/internal/noteguard"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/internal/binenc"
	"github.com/mex-memory/mex/native/record/place"
)

// The light snapshot is what the hook reads on every call that has a moment:
// each entry's id, kind, scope, triggers and recipe commands, without its
// text. It is valid while a listing stamp of the entry stores is unchanged:
// one directory read per folder, using the size and modification time the
// listing already carries. Text and checks are loaded with Load only when a
// moment has found a candidate.

const lightVersion = 4

type lightFile struct {
	Version int    `json:"version"`
	Written int64  `json:"written"`
	Stamp   string `json:"stamp"`
	Items   []Item `json:"items"`
}

func lightPath(directory, project, checkout string) string {
	return filepath.Join(directory, "delivery-entries", place.ShortHash(project+"\n"+checkout)+".light.bin")
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
	if home != "" {
		revision, err := noteguard.Token(filepath.Join(home, "projects", project, "notes"))
		if err != nil {
			return "", 0, err
		}
		_, _ = io.WriteString(h, "revision:"+revision+"\n")
	}
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
	if home != "" {
		_, _ = io.WriteString(h, "f:"+inForceStamp(home, project)+"\n")
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
func LoadLight(directory, home, project, checkout string) (answer Snapshot, failure error) {
	if !validComponent(project) {
		return Snapshot{}, ErrInvalid
	}
	if home != "" && project != "" {
		check, err := noteguard.Begin(filepath.Join(home, "projects", project, "notes"))
		if err != nil {
			return Snapshot{}, err
		}
		defer func() {
			if err := check(); err != nil {
				answer, failure = Snapshot{}, err
			}
		}()
	}

	if directory == "" || checkout == "" || !validComponent(project) {
		return Snapshot{}, ErrInvalid
	}
	stamp, newest, err := listingStamp(home, project, checkout)
	if err != nil {
		return Snapshot{}, err
	}
	path := lightPath(directory, project, checkout)
	if b, err := readRegular(path, 8*1024*1024); err == nil {
		// A file modified within 2 s of the write may share its timestamp
		// with an edit that came after it: never trust it.
		if lf, err := decodeLight(b); err == nil && lf.Version == lightVersion && lf.Stamp == stamp && newest < lf.Written-int64(2*time.Second) {
			snap := Snapshot{Light: true, Items: lf.Items, Stamp: stamp}
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
	saveFile(path, encodeLight(lf))
	full.Stamp = stamp
	return full, nil
}

// lightTargets are the check target fields moments read: a command's, and
// an import relation's, which the speed bump holds an edit against.
var lightTargets = []string{"run", "file", "pointer", "query", "from", "to"}

// lighten keeps what moments read: no text, and only command and import
// relation checks' targets.
func lighten(it Item) Item {
	e := *it.Entry
	e.Text = ""
	e.Source = Source{Type: e.Source.Type, Ref: e.Source.Ref, Label: e.Source.Label}
	var checks []Check
	for _, c := range e.Checks {
		if q, _ := c.Target["query"].(string); c.Kind == "command" || c.Kind == "relation" && q == "imports" {
			checks = append(checks, Check{Kind: c.Kind, Role: c.Role, Target: c.Target})
		}
	}
	e.Checks = checks
	return Item{Entry: &e, Level: it.Level, Path: it.Path, Hash: it.Hash, Generated: it.Generated, NeedsHintGate: it.NeedsHintGate}
}

const (
	maxLightItems = 20000
	maxList       = 256
)

func encodeLight(lf lightFile) []byte {
	var w binenc.Writer
	w.Uint(uint64(lf.Version))
	w.Int(lf.Written)
	w.String(lf.Stamp)
	w.Uint(uint64(len(lf.Items)))
	for _, it := range lf.Items {
		e := it.Entry
		w.String(it.Level)
		w.String(it.Path)
		w.String(it.Hash)
		w.Bool(it.Generated)
		w.Bool(it.NeedsHintGate)
		w.String(e.ID)
		w.String(e.Kind)
		w.Strings(e.Scope)
		w.String(e.Source.Type)
		w.String(e.Source.Ref)
		w.String(e.Source.Label)
		w.String(e.Evidence)
		w.String(e.OneLine)
		w.Uint(uint64(len(e.When)))
		for _, t := range e.When {
			w.String(t.Type)
			w.String(t.Match)
			w.String(t.Pattern)
		}
		w.Uint(uint64(len(e.Checks)))
		for _, c := range e.Checks {
			w.String(c.Kind)
			w.String(c.Role)
			for _, k := range lightTargets {
				v, _ := c.Target[k].(string)
				w.String(v)
			}
		}
		w.Strings(e.Companions)
		w.String(e.Status)
		w.String(e.Created)
		w.Strings(e.Aliases)
	}
	return w.Bytes()
}

func decodeLight(b []byte) (lightFile, error) {
	r := binenc.NewReader(b)
	lf := lightFile{Version: int(r.Uint()), Written: r.Int(), Stamp: r.String()}
	if lf.Version != lightVersion {
		return lightFile{}, ErrInvalid
	}
	n := r.Count(maxLightItems)
	lf.Items = make([]Item, 0, n)
	for i := 0; i < n && r.Err() == nil; i++ {
		it := Item{Level: r.String(), Path: r.String(), Hash: r.String(), Generated: r.Bool(), NeedsHintGate: r.Bool()}
		e := &Entry{ID: r.String(), Kind: r.String(), Scope: r.Strings(maxList)}
		e.Source = Source{Type: r.String(), Ref: r.String(), Label: r.String()}
		e.Evidence, e.OneLine = r.String(), r.String()
		for j, m := 0, r.Count(maxList); j < m; j++ {
			e.When = append(e.When, Trigger{Type: r.String(), Match: r.String(), Pattern: r.String()})
		}
		for j, m := 0, r.Count(maxList); j < m; j++ {
			c := Check{Kind: r.String(), Role: r.String(), Target: map[string]any{}}
			for _, k := range lightTargets {
				if v := r.String(); v != "" {
					c.Target[k] = v
				}
			}
			e.Checks = append(e.Checks, c)
		}
		e.Companions = r.Strings(maxList)
		e.Status, e.Created = r.String(), r.String()
		e.Aliases = r.Strings(maxList)
		it.Entry = e
		lf.Items = append(lf.Items, it)
	}
	if err := r.Done(); err != nil {
		return lightFile{}, err
	}
	return lf, nil
}

func saveFile(path string, b []byte) {
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
