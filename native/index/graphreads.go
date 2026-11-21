package index

import "github.com/mex-memory/mex/native/index/shift"

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

// CodeFiles lists every indexed file that has a language, with the hash it
// was parsed at. A file edited since its parse, or (with disk) changed on
// disk some other way, lists with an empty hash: its content is unknown here.
func (r *Reader) CodeFiles(disk bool) (map[string]string, error) {
	rows, err := r.db.Query("SELECT path,hash,mtime_ns FROM paths WHERE reason IS NULL AND hash IS NOT NULL AND lang IS NOT NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var path, hash, mtime string
		if err := rows.Scan(&path, &hash, &mtime); err != nil {
			return nil, err
		}
		pending := shiftsFor(r, path, mtime)
		if len(pending) > 0 || disk && r.changedOnDisk(path, mtime, pending) {
			hash = ""
		}
		out[path] = hash
	}
	return out, rows.Err()
}

func shiftsFor(r *Reader, rel, mtime string) []shift.Shift {
	return shift.Pending(r.directory, r.key, rel, mtime)
}
