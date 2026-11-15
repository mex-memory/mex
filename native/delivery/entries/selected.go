package entries

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/mex-memory/mex/native/internal/noteguard"
	"os"
	"path/filepath"
	"strings"
)

// Selected loads canonical bytes only for selected prompt candidates, their
// companions and prior epoch entries needed for similarity. Light-cache paths
// are leads: containment, regular files, ids and hashes are proved again.
func Selected(home, project, checkout string, snap Snapshot, wanted map[string]bool) (answer Snapshot, failure error) {
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

	if len(wanted) > 1000 {
		return Snapshot{}, ErrInvalid
	}
	inForce := InForce(home, project)
	byID := map[string]Item{}
	for _, it := range snap.Items {
		byID[it.Entry.ID] = it
	}
	out := Snapshot{}
	loaded := map[string]bool{}
	total := 0
	var load func(string) error
	load = func(id string) error {
		if loaded[id] {
			return nil
		}
		loaded[id] = true
		it, ok := byID[id]
		if !ok {
			return nil
		}
		if len(out.Items) >= 1000 {
			return ErrInvalid
		}
		base, parts := checkout, []string{".mex", "learned"}
		if it.Level == "personal" {
			base, parts = home, []string{"projects", project, "notes"}
		} else if it.Level == "hint" {
			base, parts = home, []string{"projects", project, "hints"}
		} else if it.Level != "team" {
			return ErrInvalid
		}
		root, err := contained(base, parts)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, it.Path)
		if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(filepath.ToSlash(rel), "../") || filepath.Base(rel) != id+".md" {
			return ErrInvalid
		}
		dir := filepath.Dir(rel)
		if dir != "." {
			if _, err = contained(root, strings.Split(filepath.ToSlash(dir), "/")); err != nil {
				return err
			}
		}
		parents := []string{root}
		if dir != "." {
			p := root
			for _, part := range strings.Split(filepath.ToSlash(dir), "/") {
				p = filepath.Join(p, part)
				parents = append(parents, p)
			}
		}
		before := make([]os.FileInfo, len(parents))
		for i, p := range parents {
			info, err := os.Lstat(p)
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return ErrInvalid
			}
			before[i] = info
		}
		b, err := readRegular(filepath.Join(root, rel), MaxEntryBytes)
		if err != nil {
			return err
		}
		for i, p := range parents {
			info, err := os.Lstat(p)
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !os.SameFile(before[i], info) {
				return errors.New("entry directory changed during selected read")
			}
		}
		if again, err := contained(base, parts); err != nil || !samePath(root, again) {
			return ErrInvalid
		}
		total += len(b)
		if total > maxScanBytes {
			return ErrInvalid
		}
		hash := sha256.Sum256(b)
		if "sha256:"+hex.EncodeToString(hash[:]) != it.Hash {
			return errors.New("prompt entry changed")
		}
		e, err := Parse(b)
		if err == nil {
			e = Usable(e, inForce)
		}
		if err != nil || e == nil || e.ID != id {
			return ErrInvalid
		}
		it.Entry = e
		it.Scopes = nil
		for _, scope := range e.Scope {
			sc, err := newScope(scope)
			if err != nil {
				return err
			}
			it.Scopes = append(it.Scopes, sc)
		}
		it.Generated = generatedRE().MatchString(e.OneLine + " " + e.Text)
		it.Full = Label(e, it.Level) + " " + e.Text
		it.OneLine = Label(e, it.Level) + " " + e.OneLine
		it.FullTokens = EstimateTokens(it.Full)
		it.OneLineTokens = EstimateTokens(it.OneLine)
		out.Items = append(out.Items, it)
		for _, companion := range e.Companions[:min(32, len(e.Companions))] {
			if len(out.Items) >= 1000 {
				break
			}
			if err = load(companion); err != nil {
				return err
			}
		}
		return nil
	}
	// Snapshot order is stable and preserves FCFS order.
	for _, it := range snap.Items {
		if wanted[it.Entry.ID] {
			if err := load(it.Entry.ID); err != nil {
				return Snapshot{}, err
			}
		}
	}
	return out, nil
}
