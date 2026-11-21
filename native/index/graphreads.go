package index

import (
	"runtime"
	"sync"

	"github.com/mex-memory/mex/native/index/shift"
)

// Reads the code graph needs from the file index: which files the hook has
// edited since their parse, test flags that hold while a file is edited, and
// every indexed code file with its parsed hash.

// Edited reports a file the hook has shifted since its parse: its outline
// still holds (moved through the shifts), but its hash is the parsed one, so
// it is not the content anything built from that hash saw.
func (r *Reader) Edited(path string) bool {
	rel, row, miss := r.row(path)
	if miss != nil {
		return false
	}
	return len(shiftsFor(r, rel, row.mtime)) > 0
}

// TestFlag is whether the index classed a file as a test. It reads the flag
// even while the file is being edited, since a test stays a test.
func (r *Reader) TestFlag(path string) (isTest, known bool) {
	_, row, miss := r.row(path)
	if miss != nil {
		return false, false
	}
	return row.isTest == 1, true
}

// CodeFiles lists every indexed code file (a file with a language other than
// "other": docs and config are never code), with the hash it was parsed at. A file edited since its parse, or (with disk) changed on
// disk some other way, lists with an empty hash: its content is unknown here.
func (r *Reader) CodeFiles(disk bool) (map[string]string, error) {
	rows, err := r.db.Query("SELECT path,hash,mtime_ns FROM paths WHERE reason IS NULL AND hash IS NOT NULL AND lang IS NOT NULL AND lang <> 'other'")
	if err != nil {
		return nil, err
	}
	type file struct{ path, hash, mtime string }
	var list []file
	for rows.Next() {
		var f file
		if err := rows.Scan(&f.path, &f.hash, &f.mtime); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, f)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	// One listing of the shifts, then the per-file checks in parallel: a
	// large checkout has tens of thousands of files to stat.
	shifted := shift.ShiftedPaths(r.directory, r.key)
	unknown := make([]bool, len(list))
	workers := runtime.GOMAXPROCS(0)
	if workers > 8 {
		workers = 8
	}
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := w; i < len(list); i += workers {
				f := list[i]
				var pending []shift.Shift
				if shifted.Has(f.path) {
					pending = shiftsFor(r, f.path, f.mtime)
				}
				unknown[i] = len(pending) > 0 || disk && r.changedOnDisk(f.path, f.mtime, pending)
			}
		}(w)
	}
	wg.Wait()
	out := make(map[string]string, len(list))
	for i, f := range list {
		if unknown[i] {
			f.hash = ""
		}
		out[f.path] = f.hash
	}
	return out, nil
}

func shiftsFor(r *Reader, rel, mtime string) []shift.Shift {
	return shift.Pending(r.directory, r.key, rel, mtime)
}
